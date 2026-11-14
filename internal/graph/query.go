package graph

import (
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/labels"

	"github.com/bexxmodd/kube-kvleva/internal/health"
	"github.com/bexxmodd/kube-kvleva/internal/refs"
)

const (
	// maxDepth bounds every walk along ownership, so that a cycle of owner
	// references cannot hang a request.
	maxDepth = 32
	// maxSummaryRefs caps the references carried by one Summary.
	maxSummaryRefs = 50
	// maxDetailLinks caps each list of links carried by one Detail.
	maxDetailLinks = 1000
)

// filter is the compiled form of the filter fields of a Query.
type filter struct {
	hide   map[string]bool
	health map[health.Status]bool // nil keeps every health
	text   string                 // lower case; "" keeps every name
}

func newFilter(q Query) filter {
	f := filter{text: strings.ToLower(q.Text)}
	if len(q.HideKinds) > 0 {
		f.hide = make(map[string]bool, len(q.HideKinds))
		for _, kindID := range q.HideKinds {
			f.hide[kindID] = true
		}
	}
	if len(q.Health) > 0 {
		f.health = make(map[health.Status]bool, len(q.Health))
		for _, status := range q.Health {
			f.health[health.Status(status)] = true
		}
	}
	return f
}

// narrows reports whether the filter can reject a visible resource.
func (f filter) narrows() bool {
	return f.health != nil || f.text != ""
}

// matches reports whether o itself passes the health and text filters.
func (f filter) matches(o *object) bool {
	if f.health != nil && !f.health[o.health.Status] {
		return false
	}
	return f.text == "" || strings.Contains(strings.ToLower(o.name), f.text)
}

// List returns one page of the resources selected by q, in display order.
func (s *Store) List(q Query) Page {
	s.mu.RLock()
	defer s.mu.RUnlock()

	f := newFilter(q)
	var matched []*object
	switch q.Scope {
	case ScopeNamespace:
		if q.Target != "" {
			matched = s.tree(s.roots(s.byNamespace[q.Target]), f)
		}
	case ScopeCluster:
		var candidates []*object
		for _, o := range s.roots(s.byNamespace[""]) {
			if o.kindID != namespaceKindID && o.kindID != nodeKindID {
				candidates = append(candidates, o)
			}
		}
		matched = s.tree(candidates, f)
	case ScopeChildren:
		if parent, ok := s.objects[q.Target]; ok {
			matched = s.tree(s.childrenOf(parent), f)
		}
	case ScopeNodes:
		matched = flat(s.byKind[nodeKindID], f)
	case ScopePodsOnNode:
		matched = flat(s.podsByNode[q.Target], f)
	default:
		matched = flat(s.objects, f)
	}
	sort.Slice(matched, func(i, j int) bool { return before(matched[i], matched[j]) })

	limit := q.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	limit = min(limit, MaxLimit)
	offset := max(q.Offset, 0)
	page := Page{
		Items:    make([]Summary, 0, min(limit, len(matched))),
		Total:    len(matched),
		Offset:   offset,
		Limit:    limit,
		Revision: s.revision,
	}
	for i := offset; i < min(offset+limit, len(matched)); i++ {
		page.Items = append(page.Items, s.summarize(matched[i], f))
	}
	return page
}

// flat returns the resources of idx that pass the filter, ignoring nesting.
func flat(idx index, f filter) []*object {
	var matched []*object
	for _, o := range idx {
		if !f.hide[o.kindID] && f.matches(o) {
			matched = append(matched, o)
		}
	}
	return matched
}

// tree returns what is displayed for candidates, which are siblings in the
// containment tree: hidden kinds are replaced by their contents, and a
// resource is kept when it or anything displayed inside it passes the
// filter.
func (s *Store) tree(candidates []*object, f filter) []*object {
	visible := s.promote(candidates, f, 0)
	if !f.narrows() {
		return visible
	}
	var matched []*object
	for _, o := range visible {
		if f.matches(o) || s.descendantMatches(o, f, 0) {
			matched = append(matched, o)
		}
	}
	return matched
}

// promote replaces every resource of a hidden kind by the resources nested
// in it.
func (s *Store) promote(candidates []*object, f filter, depth int) []*object {
	if f.hide == nil || depth > maxDepth {
		return candidates
	}
	var visible []*object
	for _, o := range candidates {
		if f.hide[o.kindID] {
			visible = append(visible, s.promote(s.childrenOf(o), f, depth+1)...)
		} else {
			visible = append(visible, o)
		}
	}
	return visible
}

func (s *Store) descendantMatches(o *object, f filter, depth int) bool {
	if depth > maxDepth {
		return false
	}
	for _, child := range s.promote(s.childrenOf(o), f, 0) {
		if f.matches(child) || s.descendantMatches(child, f, depth+1) {
			return true
		}
	}
	return false
}

// roots returns the resources of idx that are not nested in another
// resource.
func (s *Store) roots(idx index) []*object {
	var result []*object
	for _, o := range idx {
		if s.parentOf(o) == nil {
			result = append(result, o)
		}
	}
	return result
}

// parentOf returns the resource o is displayed inside: its first owner (the
// controller, if any), provided that owner is known and lives in the same
// namespace. An owner elsewhere, such as the Node owning a static Pod, is a
// reference instead.
func (s *Store) parentOf(o *object) *object {
	if len(o.owners) == 0 {
		return nil
	}
	parent, ok := s.objects[o.owners[0].UID]
	if !ok || parent == o || parent.namespace != o.namespace {
		return nil
	}
	return parent
}

// childrenOf returns the resources displayed directly inside o.
func (s *Store) childrenOf(o *object) []*object {
	var result []*object
	for _, child := range s.children[o.uid] {
		if s.parentOf(child) == o {
			result = append(result, child)
		}
	}
	return result
}

func (s *Store) summarize(o *object, f filter) Summary {
	links, truncated := s.links(o, maxSummaryRefs)
	return Summary{
		UID:           o.uid,
		KindID:        o.kindID,
		Group:         o.group,
		Version:       o.version,
		Kind:          o.kind,
		Namespace:     o.namespace,
		Name:          o.name,
		Health:        o.health.Status,
		Reason:        o.health.Reason,
		CreatedAt:     o.createdAt,
		ChildCount:    len(s.promote(s.childrenOf(o), f, 0)),
		Rollup:        s.rollup(o),
		SelfMatch:     f.matches(o),
		Path:          s.path(o),
		Node:          o.node,
		Containers:    o.containers,
		Refs:          links,
		RefsTruncated: truncated,
	}
}

// rollup counts o and everything nested in it by health.
func (s *Store) rollup(o *object) Rollup {
	var r Rollup
	s.addToRollup(&r, o, 0)
	return r
}

func (s *Store) addToRollup(r *Rollup, o *object, depth int) {
	r.add(o.health.Status)
	if depth > maxDepth {
		return
	}
	for _, child := range s.childrenOf(o) {
		s.addToRollup(r, child, depth+1)
	}
}

// path returns the containers of o, outermost first.
func (s *Store) path(o *object) []string {
	var owners []string
	for p, depth := s.parentOf(o), 0; p != nil && depth < maxDepth; p, depth = s.parentOf(p), depth+1 {
		owners = append(owners, p.uid)
	}
	path := make([]string, 0, len(owners)+1)
	if o.namespace == "" {
		path = append(path, "cluster")
	} else {
		path = append(path, "ns:"+o.namespace)
	}
	for i := len(owners) - 1; i >= 0; i-- {
		path = append(path, owners[i])
	}
	return path
}

func (s *Store) link(target *object, relation string) Link {
	return Link{
		UID:       target.uid,
		KindID:    target.kindID,
		Kind:      target.kind,
		Namespace: target.namespace,
		Name:      target.name,
		Health:    target.health.Status,
		Path:      s.path(target),
		Relation:  relation,
	}
}

// links returns up to limit outgoing references of o whose target exists,
// each target once, and whether there were more.
func (s *Store) links(o *object, limit int) ([]Link, bool) {
	links := make([]Link, 0)
	seen := map[string]bool{o.uid: true}
	add := func(target *object, relation string) {
		if target == nil || seen[target.uid] {
			return
		}
		seen[target.uid] = true
		links = append(links, s.link(target, relation))
	}

	// An owner that o is not displayed inside is drawn as a reference.
	parent := s.parentOf(o)
	for _, owner := range o.owners {
		if target := s.objects[owner.UID]; target != parent {
			add(target, "ownerReferences")
		}
	}
	for _, r := range o.refs {
		if len(links) > limit {
			break
		}
		add(s.resolve(o, r), r.Relation)
	}
	if o.selector != nil && len(links) <= limit {
		pods := s.selectedPods(o, limit+1-len(links))
		sort.Slice(pods, func(i, j int) bool { return pods[i].name < pods[j].name })
		for _, pod := range pods {
			add(pod, o.selector.Relation)
		}
	}
	if len(links) > limit {
		return links[:limit], true
	}
	return links, false
}

// selectedPods returns up to limit Pods matched by the selector of o.
func (s *Store) selectedPods(o *object, limit int) []*object {
	var pods []*object
	for _, candidate := range s.byNamespace[o.namespace] {
		if len(pods) >= limit {
			break
		}
		if candidate.kindID == podKindID && o.selector.Matches(labels.Set(candidate.labels)) {
			pods = append(pods, candidate)
		}
	}
	return pods
}

// resolve returns the resource r points at when declared by src, or nil
// when there is none. A reference without a namespace points into the
// namespace of src or at a cluster-scoped resource.
func (s *Store) resolve(src *object, r refs.Ref) *object {
	if r.Namespace != "" {
		return s.lookup(r, r.Namespace)
	}
	if target := s.lookup(r, src.namespace); target != nil {
		return target
	}
	if src.namespace != "" {
		return s.lookup(r, "")
	}
	return nil
}

func (s *Store) lookup(r refs.Ref, namespace string) *object {
	for _, candidate := range s.byName[nameKey{kind: r.Kind, namespace: namespace, name: r.Name}] {
		if r.Group == "" || r.Group == candidate.group {
			return candidate
		}
	}
	return nil
}

// Overview summarizes the whole cluster.
func (s *Store) Overview() Overview {
	s.mu.RLock()
	defer s.mu.RUnlock()

	overview := Overview{
		Revision:   s.revision,
		Sync:       s.syncState(),
		Kinds:      make([]KindSummary, 0, len(s.kinds)),
		Namespaces: make([]NamespaceSummary, 0, len(s.byNamespace)),
	}
	kinds := make(map[string]*KindSummary, len(s.kinds))
	for kindID, state := range s.kinds {
		kinds[kindID] = &KindSummary{
			KindID:     kindID,
			Group:      displayGroup(state.kind.Group),
			Version:    state.kind.Version,
			Kind:       state.kind.Kind,
			Namespaced: state.kind.Namespaced,
		}
	}
	namespaces := make(map[string]*NamespaceSummary)
	namespace := func(name string) *NamespaceSummary {
		ns, ok := namespaces[name]
		if !ok {
			ns = &NamespaceSummary{Name: name, Health: health.Green}
			namespaces[name] = ns
		}
		return ns
	}

	for _, o := range s.objects {
		status := o.health.Status
		overview.Health.add(status)
		if kind, ok := kinds[o.kindID]; ok {
			kind.Count++
			kind.Rollup.add(status)
		}
		switch {
		case o.namespace != "":
			ns := namespace(o.namespace)
			ns.Count++
			ns.Rollup.add(status)
		case o.kindID == namespaceKindID:
			ns := namespace(o.name)
			ns.UID, ns.Health, ns.Reason = o.uid, status, o.health.Reason
		case o.kindID == nodeKindID:
			overview.Nodes.Count++
			overview.Nodes.Rollup.add(status)
		default:
			overview.ClusterScoped.Count++
			overview.ClusterScoped.Rollup.add(status)
		}
	}

	for _, kind := range kinds {
		overview.Kinds = append(overview.Kinds, *kind)
	}
	sort.Slice(overview.Kinds, func(i, j int) bool {
		a, b := overview.Kinds[i], overview.Kinds[j]
		if ra, rb := rankOf(a.KindID), rankOf(b.KindID); ra != rb {
			return ra < rb
		}
		return a.KindID < b.KindID
	})
	for _, ns := range namespaces {
		overview.Namespaces = append(overview.Namespaces, *ns)
	}
	sort.Slice(overview.Namespaces, func(i, j int) bool {
		return overview.Namespaces[i].Name < overview.Namespaces[j].Name
	})
	return overview
}

func (s *Store) syncState() Sync {
	state := Sync{KindsTotal: len(s.kinds), Errors: make([]KindError, 0)}
	settled := 0
	for kindID, kind := range s.kinds {
		if kind.synced {
			state.KindsSynced++
		}
		if kind.err != "" {
			state.Errors = append(state.Errors, KindError{KindID: kindID, Message: kind.err})
		}
		if kind.synced || kind.err != "" {
			settled++
		}
	}
	sort.Slice(state.Errors, func(i, j int) bool { return state.Errors[i].KindID < state.Errors[j].KindID })
	state.Ready = state.KindsTotal > 0 && settled == state.KindsTotal
	return state
}
