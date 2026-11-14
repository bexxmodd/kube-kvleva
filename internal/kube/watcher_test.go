package kube

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	"github.com/bexxmodd/kube-kvleva/internal/graph"
)

var (
	deploymentsGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	secretsGVR     = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
	widgetsGVR     = schema.GroupVersionResource{Group: "example.io", Version: "v1", Resource: "widgets"}
	gadgetsGVR     = schema.GroupVersionResource{Group: "example.io", Version: "v1", Resource: "gadgets"}

	listKinds = map[schema.GroupVersionResource]string{
		deploymentsGVR: "DeploymentList",
		secretsGVR:     "SecretList",
		widgetsGVR:     "WidgetList",
		gadgetsGVR:     "GadgetList",
	}

	readVerbs = metav1.Verbs{"get", "list", "watch"}

	appsResources = &metav1.APIResourceList{
		GroupVersion: "apps/v1",
		APIResources: []metav1.APIResource{
			{Name: "deployments", Kind: "Deployment", Namespaced: true, Verbs: readVerbs},
			{Name: "deployments/status", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"get"}},
			{Name: "deployments/scale", Kind: "Scale", Namespaced: true, Verbs: metav1.Verbs{"get"}},
		},
	}
	coreResources = &metav1.APIResourceList{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{
			{Name: "secrets", Kind: "Secret", Namespaced: true, Verbs: readVerbs},
			{Name: "bindings", Kind: "Binding", Namespaced: true, Verbs: metav1.Verbs{"create"}},
		},
	}
	widgetResources = &metav1.APIResourceList{
		GroupVersion: "example.io/v1",
		APIResources: []metav1.APIResource{
			{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: readVerbs},
		},
	}
	widgetAndGadgetResources = &metav1.APIResourceList{
		GroupVersion: "example.io/v1",
		APIResources: []metav1.APIResource{
			{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: readVerbs},
			{Name: "gadgets", Kind: "Gadget", Namespaced: true, Verbs: readVerbs},
		},
	}
)

// fakeDiscovery answers API discovery with a list that tests can change
// while the watcher runs.
type fakeDiscovery struct {
	mu        sync.Mutex
	resources []*metav1.APIResourceList
}

func (d *fakeDiscovery) ServerPreferredResources() ([]*metav1.APIResourceList, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.resources, nil
}

func (d *fakeDiscovery) set(resources ...*metav1.APIResourceList) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.resources = resources
}

func clusterObject(apiVersion, kind, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": apiVersion,
		"kind":       kind,
		"metadata": map[string]any{
			"namespace":       "default",
			"name":            name,
			"uid":             kind + "-" + name,
			"resourceVersion": "1",
		},
	}}
}

// startWatcher runs a Watcher against a fake cluster until the test ends.
func startWatcher(t *testing.T, discovery *fakeDiscovery, client *dynamicfake.FakeDynamicClient, opts WatcherOptions) *graph.Store {
	t.Helper()
	store := graph.New()
	if opts.RediscoverEvery == 0 {
		opts.RediscoverEvery = 10 * time.Millisecond
	}
	watcher := NewWatcher(discovery, client, store, opts)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		watcher.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return store
}

// eventually polls cond until it holds or a generous deadline passes.
func eventually(cond func() bool) bool {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

func resourceNames(store *graph.Store) []string {
	var names []string
	for _, item := range store.List(graph.Query{Scope: graph.ScopeAll}).Items {
		names = append(names, item.Kind+"/"+item.Name)
	}
	return names
}

func TestWatcherLoadsBuiltInAndCustomResources(t *testing.T) {
	discovery := &fakeDiscovery{}
	discovery.set(appsResources, widgetResources)
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterObject("apps/v1", "Deployment", "web"),
		clusterObject("example.io/v1", "Widget", "gadget"),
	)

	store := startWatcher(t, discovery, client, WatcherOptions{})

	if !eventually(func() bool { return store.Overview().Sync.Ready }) {
		t.Fatalf("store never became ready; sync state: %+v", store.Overview().Sync)
	}
	want := []string{"Deployment/web", "Widget/gadget"}
	if diff := cmp.Diff(want, resourceNames(store)); diff != "" {
		t.Errorf("resources after sync diff (-want +got):\n%s", diff)
	}
	wantKinds := []graph.KindSummary{
		{KindID: "apps/Deployment", Group: "apps", Version: "v1", Kind: "Deployment", Namespaced: true, Count: 1, Rollup: graph.Rollup{Yellow: 1}},
		{KindID: "example.io/Widget", Group: "example.io", Version: "v1", Kind: "Widget", Namespaced: true, Count: 1, Rollup: graph.Rollup{Green: 1}},
	}
	if diff := cmp.Diff(wantKinds, store.Overview().Kinds); diff != "" {
		t.Errorf("kinds after sync diff (-want +got):\n%s", diff)
	}
}

func TestWatcherSkipsExcludedAndUnreadableResources(t *testing.T) {
	discovery := &fakeDiscovery{}
	discovery.set(appsResources, coreResources, widgetResources)
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterObject("apps/v1", "Deployment", "web"),
		clusterObject("v1", "Secret", "db"),
		clusterObject("example.io/v1", "Widget", "gadget"),
	)

	store := startWatcher(t, discovery, client, WatcherOptions{Exclude: []string{"secrets", "widgets.example.io"}})

	if !eventually(func() bool { return store.Overview().Sync.Ready }) {
		t.Fatalf("store never became ready; sync state: %+v", store.Overview().Sync)
	}
	if diff := cmp.Diff([]string{"Deployment/web"}, resourceNames(store)); diff != "" {
		t.Errorf("resources after sync diff (-want +got):\n%s", diff)
	}
	// Excluded types must not even be requested from the cluster, and
	// neither must sub-resources or types that cannot be listed.
	for _, action := range client.Actions() {
		if resource := action.GetResource().Resource; resource != "deployments" {
			t.Errorf("watcher sent %s %s to the cluster, want only deployments to be read", action.GetVerb(), resource)
		}
	}
}

func TestWatcherFollowsChanges(t *testing.T) {
	discovery := &fakeDiscovery{}
	discovery.set(widgetResources)
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterObject("example.io/v1", "Widget", "first"),
	)
	store := startWatcher(t, discovery, client, WatcherOptions{})
	if !eventually(func() bool { return store.Overview().Sync.Ready }) {
		t.Fatalf("store never became ready; sync state: %+v", store.Overview().Sync)
	}
	widgets := client.Resource(widgetsGVR).Namespace("default")

	// The fake cluster only delivers changes made after the watch is
	// established, so keep touching the new widget until it is seen.
	second := clusterObject("example.io/v1", "Widget", "second")
	if _, err := widgets.Create(t.Context(), second, metav1.CreateOptions{}); err != nil {
		t.Fatalf("creating widget in the fake cluster: %v", err)
	}
	version := 1
	seen := eventually(func() bool {
		version++
		second.SetResourceVersion(fmt.Sprint(version))
		if _, err := widgets.Update(t.Context(), second, metav1.UpdateOptions{}); err != nil {
			return false
		}
		_, ok := store.Detail("Widget-second")
		return ok
	})
	if !seen {
		t.Fatalf("a widget created after startup never appeared; resources: %v", resourceNames(store))
	}

	if err := widgets.Delete(t.Context(), "first", metav1.DeleteOptions{}); err != nil {
		t.Fatalf("deleting widget in the fake cluster: %v", err)
	}
	gone := eventually(func() bool {
		_, ok := store.Detail("Widget-first")
		return !ok
	})
	if !gone {
		t.Errorf("a deleted widget never disappeared; resources: %v", resourceNames(store))
	}
}

func TestWatcherPicksUpResourceTypesAddedLater(t *testing.T) {
	discovery := &fakeDiscovery{}
	discovery.set(widgetResources)
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterObject("example.io/v1", "Widget", "gadget"),
		clusterObject("example.io/v1", "Gadget", "gizmo"),
	)
	store := startWatcher(t, discovery, client, WatcherOptions{})
	if !eventually(func() bool { return store.Overview().Sync.Ready }) {
		t.Fatalf("store never became ready; sync state: %+v", store.Overview().Sync)
	}
	if diff := cmp.Diff([]string{"Widget/gadget"}, resourceNames(store)); diff != "" {
		t.Fatalf("resources before the new type is installed diff (-want +got):\n%s", diff)
	}

	discovery.set(widgetAndGadgetResources)

	appeared := eventually(func() bool {
		_, ok := store.Detail("Gadget-gizmo")
		return ok
	})
	if !appeared {
		t.Errorf("an instance of a resource type installed after startup never appeared; resources: %v", resourceNames(store))
	}
}

func TestWatcherForgetsResourceTypesThatAreRemoved(t *testing.T) {
	discovery := &fakeDiscovery{}
	discovery.set(appsResources, widgetResources)
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterObject("apps/v1", "Deployment", "web"),
		clusterObject("example.io/v1", "Widget", "gadget"),
	)
	store := startWatcher(t, discovery, client, WatcherOptions{})
	if !eventually(func() bool { return len(resourceNames(store)) == 2 }) {
		t.Fatalf("resources never loaded; resources: %v", resourceNames(store))
	}

	discovery.set(appsResources)

	forgotten := eventually(func() bool { return len(store.Overview().Kinds) == 1 })
	if !forgotten {
		t.Fatalf("a removed resource type is still known; kinds: %+v", store.Overview().Kinds)
	}
	if diff := cmp.Diff([]string{"Deployment/web"}, resourceNames(store)); diff != "" {
		t.Errorf("resources after the type was removed diff (-want +got):\n%s", diff)
	}
}

func TestWatcherReportsResourceTypesItCannotRead(t *testing.T) {
	discovery := &fakeDiscovery{}
	discovery.set(appsResources, widgetResources)
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterObject("apps/v1", "Deployment", "web"),
	)
	forbidden := apierrors.NewForbidden(schema.GroupResource{Group: "example.io", Resource: "widgets"}, "", nil)
	client.PrependReactor("list", "widgets", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, forbidden
	})

	store := startWatcher(t, discovery, client, WatcherOptions{})

	if !eventually(func() bool { return store.Overview().Sync.Ready }) {
		t.Fatalf("store never settled; sync state: %+v", store.Overview().Sync)
	}
	sync := store.Overview().Sync
	if len(sync.Errors) != 1 || sync.Errors[0].KindID != "example.io/Widget" {
		t.Errorf("sync errors = %+v, want exactly one for example.io/Widget", sync.Errors)
	}
	if diff := cmp.Diff([]string{"Deployment/web"}, resourceNames(store)); diff != "" {
		t.Errorf("resources diff (-want +got):\n%s", diff)
	}
}
