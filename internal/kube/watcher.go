package kube

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/cache"

	"github.com/bexxmodd/kube-kvleva/internal/graph"
)

// defaultRediscoverEvery is how often the cluster is asked which resource
// types it serves, so that newly installed CustomResourceDefinitions show up
// without a restart.
const defaultRediscoverEvery = 30 * time.Second

// resourceLister is the part of API discovery the Watcher needs.
type resourceLister interface {
	ServerPreferredResources() ([]*metav1.APIResourceList, error)
}

// WatcherOptions tunes a Watcher.
type WatcherOptions struct {
	// Exclude lists resource types that are not loaded, named "<resource>"
	// for the core group and "<resource>.<group>" otherwise.
	Exclude []string
	// RediscoverEvery is how often the served resource types are looked up
	// again. Zero means every 30 seconds.
	RediscoverEvery time.Duration
}

// Watcher loads every resource of a cluster into a graph.Store and keeps it
// up to date. It discovers the resource types the cluster serves, including
// custom resources, and lists and watches each of them.
type Watcher struct {
	discovery       resourceLister
	client          dynamic.Interface
	store           *graph.Store
	exclude         map[string]bool
	rediscoverEvery time.Duration
}

// NewWatcher returns a Watcher that fills store from the cluster reached
// through discovery and client.
func NewWatcher(discovery resourceLister, client dynamic.Interface, store *graph.Store, opts WatcherOptions) *Watcher {
	w := &Watcher{
		discovery:       discovery,
		client:          client,
		store:           store,
		exclude:         make(map[string]bool, len(opts.Exclude)),
		rediscoverEvery: opts.RediscoverEvery,
	}
	for _, name := range opts.Exclude {
		w.exclude[name] = true
	}
	if w.rediscoverEvery <= 0 {
		w.rediscoverEvery = defaultRediscoverEvery
	}
	return w
}

// resource is one resource type served by the cluster.
type resource struct {
	gvr  schema.GroupVersionResource
	kind graph.Kind
}

// reflection is a running list-and-watch of one resource type.
type reflection struct {
	kindID string
	cancel context.CancelFunc
	done   <-chan struct{}
}

// Run keeps the store in step with the cluster until ctx is done. It
// returns after every watch it started has stopped.
func (w *Watcher) Run(ctx context.Context) {
	var wg sync.WaitGroup
	defer wg.Wait()

	running := make(map[schema.GroupVersionResource]reflection)
	ticker := time.NewTicker(w.rediscoverEvery)
	defer ticker.Stop()
	for {
		w.reconcile(ctx, running, &wg)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// reconcile starts watching resource types that appeared and stops watching
// those that are gone.
func (w *Watcher) reconcile(ctx context.Context, running map[schema.GroupVersionResource]reflection, wg *sync.WaitGroup) {
	served, complete := w.discover()
	for gvr, res := range served {
		if _, ok := running[gvr]; ok {
			continue
		}
		w.store.AddKind(res.kind)
		reflectCtx, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		running[gvr] = reflection{kindID: res.kind.ID(), cancel: cancel, done: done}
		wg.Go(func() {
			defer close(done)
			w.reflect(reflectCtx, res)
		})
	}
	if !complete {
		// Part of the API did not answer. Its resource types are most
		// likely still there, so nothing is dropped on incomplete data.
		return
	}
	for gvr, r := range running {
		if _, ok := served[gvr]; ok {
			continue
		}
		r.cancel()
		<-r.done
		delete(running, gvr)
		w.store.RemoveKind(r.kindID)
	}
}

// discover returns the resource types to load, and whether the cluster
// answered for all of its API groups.
func (w *Watcher) discover() (map[schema.GroupVersionResource]resource, bool) {
	lists, err := w.discovery.ServerPreferredResources()
	if err != nil {
		// Discovery reports partial results together with an error when
		// some API groups (typically aggregated ones) are unavailable.
		log.Printf("Discovering resource types: %v", err)
	}
	served := make(map[schema.GroupVersionResource]resource)
	seen := make(map[string]bool)
	for _, list := range lists {
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range list.APIResources {
			if !w.wanted(gv.Group, r) {
				continue
			}
			res := resource{
				gvr:  gv.WithResource(r.Name),
				kind: graph.Kind{Group: gv.Group, Version: gv.Version, Kind: r.Kind, Namespaced: r.Namespaced},
			}
			if seen[res.kind.ID()] {
				continue
			}
			seen[res.kind.ID()] = true
			served[res.gvr] = res
		}
	}
	return served, err == nil
}

// wanted reports whether a discovered resource should be loaded: it must be
// a real resource (not a sub-resource such as "pods/log") that can be
// listed and watched, and it must not be excluded.
func (w *Watcher) wanted(group string, r metav1.APIResource) bool {
	if strings.Contains(r.Name, "/") {
		return false
	}
	name := r.Name
	if group != "" {
		name += "." + group
	}
	if w.exclude[name] {
		return false
	}
	var canList, canWatch bool
	for _, verb := range r.Verbs {
		switch verb {
		case "list":
			canList = true
		case "watch":
			canWatch = true
		}
	}
	return canList && canWatch
}

// pagedLists makes a reflector load a resource type as a paged list followed
// by a watch. The alternative, one stream that carries the entire initial
// state, would have the reflector buffer every object of the type before
// handing any of them over, which is exactly the memory peak that loading
// page by page avoids.
type pagedLists struct{}

// IsWatchListSemanticsUnSupported implements the opt-out that reflectors
// look for on the client.
func (pagedLists) IsWatchListSemanticsUnSupported() bool { return true }

// reflect lists and watches one resource type until ctx is done, feeding
// what it sees into the store.
func (w *Watcher) reflect(ctx context.Context, res resource) {
	client := w.client.Resource(res.gvr)
	kindID := res.kind.ID()
	listWatch := &cache.ListWatch{
		ListWithContextFunc: func(ctx context.Context, options metav1.ListOptions) (runtime.Object, error) {
			// Without a resource version the cluster honors the page size
			// the reflector asks for; with one it may answer with the whole
			// resource type at once.
			options.ResourceVersion = ""
			options.ResourceVersionMatch = ""
			page, err := client.List(ctx, options)
			if err != nil {
				w.store.SetKindError(kindID, err.Error())
				return nil, err
			}
			return w.absorb(res.kind, page), nil
		},
		WatchFuncWithContext: func(ctx context.Context, options metav1.ListOptions) (watch.Interface, error) {
			watcher, err := client.Watch(ctx, options)
			if err != nil {
				w.store.SetKindError(kindID, err.Error())
				return nil, err
			}
			w.store.SetKindError(kindID, "")
			return watcher, nil
		},
	}
	reflector := cache.NewReflectorWithOptions(
		cache.ToListWatcherWithWatchListSemantics(listWatch, pagedLists{}),
		&unstructured.Unstructured{},
		&sink{store: w.store, kind: res.kind},
		cache.ReflectorOptions{Name: "kvleva/" + kindID},
	)
	reflector.RunWithContext(ctx)
}

// absorb stores the objects of one page of a listing right away and returns
// the page with every object reduced to its identity. The reflector collects
// all pages before it reports the listing as complete; handing it only
// identities keeps a resource type with very many objects from ever being
// held in memory as a whole.
func (w *Watcher) absorb(kind graph.Kind, page *unstructured.UnstructuredList) *unstructured.UnstructuredList {
	identities := &unstructured.UnstructuredList{
		Object: page.Object,
		Items:  make([]unstructured.Unstructured, len(page.Items)),
	}
	for i := range page.Items {
		item := &page.Items[i]
		identity := &identities.Items[i]
		identity.SetAPIVersion(item.GetAPIVersion())
		identity.SetKind(item.GetKind())
		identity.SetNamespace(item.GetNamespace())
		identity.SetName(item.GetName())
		identity.SetUID(item.GetUID())
		identity.SetResourceVersion(item.GetResourceVersion())
		if err := w.store.Upsert(kind, item.Object); err != nil {
			log.Printf("Loading %s: %v", kind.ID(), err)
		}
	}
	return identities
}

// sink receives what a reflector observes for one resource type and applies
// it to the store. It implements cache.ReflectorStore.
type sink struct {
	store *graph.Store
	kind  graph.Kind
}

func (s *sink) Add(obj any) error {
	return s.upsert(obj)
}

func (s *sink) Update(obj any) error {
	return s.upsert(obj)
}

func (s *sink) Delete(obj any) error {
	if u, ok := obj.(*unstructured.Unstructured); ok {
		s.store.Delete(string(u.GetUID()))
	}
	return nil
}

// Replace is called when a listing is complete. Its objects were already
// stored by absorb, so all that is left is to drop what was not listed.
func (s *sink) Replace(items []any, _ string) error {
	listed := make([]string, 0, len(items))
	for _, item := range items {
		if u, ok := item.(*unstructured.Unstructured); ok {
			listed = append(listed, string(u.GetUID()))
		}
	}
	s.store.PruneKind(s.kind.ID(), listed)
	return nil
}

func (s *sink) Resync() error {
	return nil
}

func (s *sink) upsert(obj any) error {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return nil
	}
	if err := s.store.Upsert(s.kind, u.Object); err != nil {
		log.Printf("Loading %s: %v", s.kind.ID(), err)
	}
	return nil
}
