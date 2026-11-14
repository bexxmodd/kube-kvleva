package graph

import (
	"bytes"
	"compress/flate"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"sync"

	"github.com/bexxmodd/kube-kvleva/internal/health"
	"github.com/bexxmodd/kube-kvleva/internal/refs"
)

// redacted replaces every Secret value. Secret contents are dropped when a
// Secret is stored, so they are neither kept in memory nor sent anywhere.
const redacted = "<redacted>"

// lastAppliedAnnotation holds a full copy of the manifest, including Secret
// values, so it is dropped from every stored manifest.
const lastAppliedAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

// maxPendingChanges is how many changed resources a Subscription enumerates
// before it reports an overflow instead.
const maxPendingChanges = 500

// object is the stored form of one resource.
type object struct {
	uid             string
	kindID          string
	group           string // display form: CoreGroup for the core group
	version         string
	kind            string
	namespace       string
	name            string
	resourceVersion string
	createdAt       string
	rank            int
	health          health.Result
	owners          []refs.Owner
	refs            []refs.Ref
	selector        *refs.PodSelector
	// labels, node, and containers are only kept for Pods.
	labels     map[string]string
	node       string
	containers []Container
	// manifest is the deflate-compressed JSON of the sanitized object.
	manifest []byte
}

type nameKey struct {
	kind, namespace, name string
}

type kindState struct {
	kind   Kind
	synced bool
	err    string
}

type index map[string]*object

// Store is the in-memory model of a cluster. It is safe for concurrent use.
type Store struct {
	mu       sync.RWMutex
	revision uint64
	objects  index
	byName   map[nameKey][]*object
	// children maps the uid of a potential parent (the first owner) to the
	// resources that name it. Whether they are actually nested is decided
	// by parentOf, because the owner may be missing or in another scope.
	children    map[string]index
	byNamespace map[string]index // "" holds cluster-scoped resources
	byKind      map[string]index
	podsByNode  map[string]index
	kinds       map[string]*kindState
	subs        map[*Subscription]struct{}
}

// New returns an empty Store.
func New() *Store {
	return &Store{
		objects:     make(index),
		byName:      make(map[nameKey][]*object),
		children:    make(map[string]index),
		byNamespace: make(map[string]index),
		byKind:      make(map[string]index),
		podsByNode:  make(map[string]index),
		kinds:       make(map[string]*kindState),
		subs:        make(map[*Subscription]struct{}),
	}
}

// AddKind registers a resource type that is going to be loaded. Until
// MarkSynced, PruneKind, or SetKindError is called for it, the cluster is
// reported as still loading.
func (s *Store) AddKind(kind Kind) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.kinds[kind.ID()]; ok {
		return
	}
	s.kinds[kind.ID()] = &kindState{kind: kind}
	s.bump()
}

// MarkSynced records that every resource of the kind has been loaded.
func (s *Store) MarkSynced(kindID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.markSynced(kindID) {
		s.bump()
	}
}

// SetKindError records why a kind could not be loaded. An empty message
// clears the error.
func (s *Store) SetKindError(kindID, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.kinds[kindID]
	if !ok || state.err == message {
		return
	}
	state.err = message
	s.bump()
}

// RemoveKind forgets a resource type and every resource of it, for example
// after its CustomResourceDefinition was deleted.
func (s *Store) RemoveKind(kindID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, o := range s.byKind[kindID] {
		s.remove(o)
		s.recordDeleted(o.uid)
	}
	delete(s.kinds, kindID)
	s.bump()
}

// Upsert stores obj, the decoded content of a Kubernetes object of the given
// kind, replacing any earlier version. The Store takes ownership of obj and
// modifies it.
func (s *Store) Upsert(kind Kind, obj map[string]any) error {
	o, err := newObject(kind, obj)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.put(o) {
		s.recordChanged(o.uid)
		s.bump()
	}
	return nil
}

// Delete removes the resource with the given uid, if present.
func (s *Store) Delete(uid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.objects[uid]
	if !ok {
		return
	}
	s.remove(o)
	s.recordDeleted(uid)
	s.bump()
}

// PruneKind removes the resources of the given kind whose uid is not in
// keep, and marks the kind as loaded without error. It completes a fresh
// listing of the kind: the listed objects are stored with Upsert as they
// arrive, and PruneKind then drops what the cluster no longer has.
func (s *Store) PruneKind(kindID string, keep []string) {
	current := make(map[string]struct{}, len(keep))
	for _, uid := range keep {
		current[uid] = struct{}{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for uid, o := range s.byKind[kindID] {
		if _, ok := current[uid]; !ok {
			s.remove(o)
			s.recordDeleted(uid)
			changed = true
		}
	}
	if state, ok := s.kinds[kindID]; ok && state.err != "" {
		state.err = ""
		changed = true
	}
	if s.markSynced(kindID) || changed {
		s.bump()
	}
}

// Subscribe returns a Subscription that accumulates the changes made to the
// Store from now on. The caller must Close it.
func (s *Store) Subscribe() *Subscription {
	sub := &Subscription{
		store:   s,
		changed: make(map[string]struct{}),
		deleted: make(map[string]struct{}),
		ready:   make(chan struct{}, 1),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs[sub] = struct{}{}
	return sub
}

// Revision returns a number that increases with every change to the Store.
func (s *Store) Revision() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.revision
}

func (s *Store) markSynced(kindID string) bool {
	state, ok := s.kinds[kindID]
	if !ok || state.synced {
		return false
	}
	state.synced = true
	return true
}

// bump advances the revision and wakes every subscriber. The caller holds
// s.mu.
func (s *Store) bump() {
	s.revision++
	for sub := range s.subs {
		sub.wake()
	}
}

func (s *Store) recordChanged(uid string) {
	for sub := range s.subs {
		sub.record(uid, false)
	}
}

func (s *Store) recordDeleted(uid string) {
	for sub := range s.subs {
		sub.record(uid, true)
	}
}

// put stores o and reports whether that changed anything. An object with
// the resource version already stored is the same object seen again, which
// happens whenever a watch is re-established.
func (s *Store) put(o *object) bool {
	if old, ok := s.objects[o.uid]; ok {
		if old.resourceVersion != "" && old.resourceVersion == o.resourceVersion {
			return false
		}
		s.remove(old)
	}
	s.objects[o.uid] = o
	key := nameKey{kind: o.kind, namespace: o.namespace, name: o.name}
	s.byName[key] = append(s.byName[key], o)
	insert(s.byNamespace, o.namespace, o)
	insert(s.byKind, o.kindID, o)
	if len(o.owners) > 0 {
		insert(s.children, o.owners[0].UID, o)
	}
	if o.kindID == podKindID && o.node != "" {
		insert(s.podsByNode, o.node, o)
	}
	return true
}

func (s *Store) remove(o *object) {
	delete(s.objects, o.uid)
	key := nameKey{kind: o.kind, namespace: o.namespace, name: o.name}
	remaining := s.byName[key][:0]
	for _, other := range s.byName[key] {
		if other.uid != o.uid {
			remaining = append(remaining, other)
		}
	}
	if len(remaining) == 0 {
		delete(s.byName, key)
	} else {
		s.byName[key] = remaining
	}
	evict(s.byNamespace, o.namespace, o)
	evict(s.byKind, o.kindID, o)
	if len(o.owners) > 0 {
		evict(s.children, o.owners[0].UID, o)
	}
	if o.kindID == podKindID && o.node != "" {
		evict(s.podsByNode, o.node, o)
	}
}

func insert(m map[string]index, key string, o *object) {
	bucket, ok := m[key]
	if !ok {
		bucket = make(index)
		m[key] = bucket
	}
	bucket[o.uid] = o
}

func evict(m map[string]index, key string, o *object) {
	bucket := m[key]
	delete(bucket, o.uid)
	if len(bucket) == 0 {
		delete(m, key)
	}
}

// newObject reduces a decoded Kubernetes object to its stored form. It
// modifies obj.
func newObject(kind Kind, obj map[string]any) (*object, error) {
	metadata, _ := obj["metadata"].(map[string]any)
	uid, _ := metadata["uid"].(string)
	name, _ := metadata["name"].(string)
	if uid == "" || name == "" {
		return nil, fmt.Errorf("%s object has no uid or no name", kind.ID())
	}
	relations := refs.Extract(obj)
	o := &object{
		uid:      uid,
		kindID:   kind.ID(),
		group:    displayGroup(kind.Group),
		version:  kind.Version,
		kind:     kind.Kind,
		name:     name,
		rank:     rankOf(kind.ID()),
		health:   health.Evaluate(obj),
		owners:   relations.Owners,
		refs:     relations.Refs,
		selector: relations.PodSelector,
	}
	o.namespace, _ = metadata["namespace"].(string)
	o.resourceVersion, _ = metadata["resourceVersion"].(string)
	o.createdAt, _ = metadata["creationTimestamp"].(string)
	if o.kindID == podKindID {
		spec, _ := obj["spec"].(map[string]any)
		o.node, _ = spec["nodeName"].(string)
		o.labels = stringMap(metadata["labels"])
		for _, c := range health.Containers(obj) {
			o.containers = append(o.containers, Container{
				Name:     c.Name,
				Image:    c.Image,
				Init:     c.Init,
				Health:   c.Status,
				State:    c.State,
				Reason:   c.Reason,
				Ready:    c.Ready,
				Restarts: c.Restarts,
			})
		}
	}
	sanitize(o.kindID, obj)
	manifest, err := compress(obj)
	if err != nil {
		return nil, fmt.Errorf("encoding %s %s: %v", o.kindID, name, err)
	}
	o.manifest = manifest
	return o, nil
}

// sanitize removes what must not or need not be kept from obj: bookkeeping
// that only adds noise, and the values of Secrets.
func sanitize(kindID string, obj map[string]any) {
	if metadata, ok := obj["metadata"].(map[string]any); ok {
		delete(metadata, "managedFields")
		if annotations, ok := metadata["annotations"].(map[string]any); ok {
			delete(annotations, lastAppliedAnnotation)
			if len(annotations) == 0 {
				delete(metadata, "annotations")
			}
		}
	}
	if kindID != secretKindID {
		return
	}
	for _, field := range []string{"data", "stringData"} {
		values, ok := obj[field].(map[string]any)
		if !ok {
			continue
		}
		for key := range values {
			values[key] = redacted
		}
	}
}

// compressors recycles deflate writers. Creating one allocates several
// hundred kilobytes of tables, which would dominate the cost of storing an
// object.
var compressors = sync.Pool{
	New: func() any {
		// NewWriter only fails for an invalid level.
		w, _ := flate.NewWriter(io.Discard, flate.BestSpeed)
		return w
	},
}

func compress(obj map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	w := compressors.Get().(*flate.Writer)
	defer compressors.Put(w)
	w.Reset(&buf)
	if err := json.NewEncoder(w).Encode(obj); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// decode returns the stored, sanitized content of o.
func (o *object) decode() (map[string]any, error) {
	r := flate.NewReader(bytes.NewReader(o.manifest))
	defer r.Close()
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

func stringMap(v any) map[string]string {
	raw, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]string, len(raw))
	for key, value := range raw {
		if text, ok := value.(string); ok {
			result[key] = text
		}
	}
	return result
}

// Subscription accumulates the changes made to a Store until they are
// taken. It is safe for concurrent use.
type Subscription struct {
	store *Store

	mu       sync.Mutex
	changed  map[string]struct{}
	deleted  map[string]struct{}
	overflow bool
	ready    chan struct{}
}

// Ready returns a channel that receives a value when there are changes to
// Take.
func (sub *Subscription) Ready() <-chan struct{} {
	return sub.ready
}

// Take returns the changes accumulated since the previous call and starts a
// new batch.
func (sub *Subscription) Take() Change {
	sub.mu.Lock()
	change := Change{
		Changed:  sortedKeys(sub.changed),
		Deleted:  sortedKeys(sub.deleted),
		Overflow: sub.overflow,
	}
	sub.changed = make(map[string]struct{})
	sub.deleted = make(map[string]struct{})
	sub.overflow = false
	select {
	case <-sub.ready:
	default:
	}
	sub.mu.Unlock()

	change.Revision = sub.store.Revision()
	return change
}

// Close stops the Subscription from accumulating changes.
func (sub *Subscription) Close() {
	sub.store.mu.Lock()
	defer sub.store.mu.Unlock()
	delete(sub.store.subs, sub)
}

func (sub *Subscription) record(uid string, deleted bool) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if sub.overflow {
		return
	}
	if deleted {
		delete(sub.changed, uid)
		sub.deleted[uid] = struct{}{}
	} else {
		delete(sub.deleted, uid)
		sub.changed[uid] = struct{}{}
	}
	if len(sub.changed)+len(sub.deleted) > maxPendingChanges {
		sub.overflow = true
		sub.changed = make(map[string]struct{})
		sub.deleted = make(map[string]struct{})
	}
}

func (sub *Subscription) wake() {
	select {
	case sub.ready <- struct{}{}:
	default:
	}
}

func sortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
