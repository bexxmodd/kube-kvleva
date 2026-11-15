package graph

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
)

func TestDetailShowsConfigurationThenStatus(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: default
  name: web
  generation: 1
  uid: uid-web
  resourceVersion: "42"
  creationTimestamp: "2026-11-14T17:00:00Z"
  managedFields:
  - {manager: kubectl, operation: Apply}
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"kind":"Deployment"}'
    team: storefront
spec:
  replicas: 2
status:
  observedGeneration: 1
  replicas: 2
  updatedReplicas: 2
  availableReplicas: 1
`)

	got, ok := s.Detail("uid-web")
	if !ok {
		t.Fatalf("Detail(%q) not found", "uid-web")
	}
	wantYAML := `apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    team: storefront
  creationTimestamp: "2026-11-14T17:00:00Z"
  generation: 1
  name: web
  namespace: default
  resourceVersion: "42"
  uid: uid-web
spec:
  replicas: 2
`
	if diff := cmp.Diff(wantYAML, got.YAML); diff != "" {
		t.Errorf("Detail(%q).YAML diff (-want +got):\n%s", "uid-web", diff)
	}
	wantStatus := `availableReplicas: 1
observedGeneration: 1
replicas: 2
updatedReplicas: 2
`
	if diff := cmp.Diff(wantStatus, got.StatusYAML); diff != "" {
		t.Errorf("Detail(%q).StatusYAML diff (-want +got):\n%s", "uid-web", diff)
	}
	if got.Summary.Health != "yellow" || got.Summary.Reason != "1/2 replicas available" {
		t.Errorf("Detail(%q) health = %q (%q), want yellow (1/2 replicas available)", "uid-web", got.Summary.Health, got.Summary.Reason)
	}
	if got.Summary.CreatedAt != "2026-11-14T17:00:00Z" {
		t.Errorf("Detail(%q).Summary.CreatedAt = %q, want %q", "uid-web", got.Summary.CreatedAt, "2026-11-14T17:00:00Z")
	}
}

func TestDetailOfResourceWithoutStatus(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: settings}
data: {mode: fast}
`)

	got, ok := s.Detail("configmap-settings")
	if !ok {
		t.Fatalf("Detail(%q) not found", "configmap-settings")
	}
	if got.StatusYAML != "" {
		t.Errorf("Detail(%q).StatusYAML = %q, want empty", "configmap-settings", got.StatusYAML)
	}
	if !strings.Contains(got.YAML, "mode: fast") {
		t.Errorf("Detail(%q).YAML = %q, want it to contain the data", "configmap-settings", got.YAML)
	}
}

func TestDetailRedactsSecretValues(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: v1
kind: Secret
metadata:
  namespace: default
  name: db
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"password":"aHVudGVyMg=="}}'
type: Opaque
data:
  password: aHVudGVyMg==
stringData:
  token: plain-text-token
`)

	got, ok := s.Detail("secret-db")
	if !ok {
		t.Fatalf("Detail(%q) not found", "secret-db")
	}
	for _, leaked := range []string{"aHVudGVyMg==", "plain-text-token"} {
		if strings.Contains(got.YAML, leaked) {
			t.Errorf("Detail(%q).YAML leaks the secret value %q:\n%s", "secret-db", leaked, got.YAML)
		}
	}
	for _, key := range []string{"password:", "token:"} {
		if !strings.Contains(got.YAML, key) {
			t.Errorf("Detail(%q).YAML does not show the entry name %q:\n%s", "secret-db", key, got.YAML)
		}
	}
}

func TestDetailListsConditionsNewestFirst(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
spec:
  parentRefs:
  - {name: edge}
status:
  parents:
  - parentRef: {name: edge}
    conditions:
    - {type: ResolvedRefs, status: "True", reason: ResolvedRefs, lastTransitionTime: "2026-11-14T10:00:00Z"}
    - {type: Accepted, status: "True", reason: Accepted, message: route accepted, lastTransitionTime: "2026-11-14T12:00:00Z"}
`)

	got, ok := s.Detail("httproute-web")
	if !ok {
		t.Fatalf("Detail(%q) not found", "httproute-web")
	}
	want := []Condition{
		{Type: "Accepted", Status: "True", Reason: "Accepted", Message: "route accepted", LastTransitionTime: "2026-11-14T12:00:00Z", Source: "parents[0]"},
		{Type: "ResolvedRefs", Status: "True", Reason: "ResolvedRefs", LastTransitionTime: "2026-11-14T10:00:00Z", Source: "parents[0]"},
	}
	if diff := cmp.Diff(want, got.Conditions); diff != "" {
		t.Errorf("Detail(%q).Conditions diff (-want +got):\n%s", "httproute-web", diff)
	}
}

func TestDetailListsConnectionsInBothDirections(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb, podWeb, nodeWorker1, `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {namespace: default, name: edge}
`, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
spec:
  parentRefs:
  - {name: edge}
  rules:
  - backendRefs:
    - {name: web}
    - {name: does-not-exist}
`, `
apiVersion: v1
kind: Service
metadata: {namespace: default, name: web}
spec:
  selector: {app: web}
`)

	gateway, ok := s.Detail("gateway-edge")
	if !ok {
		t.Fatalf("Detail(%q) not found", "gateway-edge")
	}
	if diff := cmp.Diff([]string{"parentRefs -> HTTPRoute/web"}, linkNames(gateway.Incoming)); diff != "" {
		t.Errorf("Detail(gateway).Incoming diff (-want +got):\n%s", diff)
	}

	route, ok := s.Detail("httproute-web")
	if !ok {
		t.Fatalf("Detail(%q) not found", "httproute-web")
	}
	wantOutgoing := []string{"parentRefs -> Gateway/edge", "backendRefs -> Service/web"}
	if diff := cmp.Diff(wantOutgoing, linkNames(route.Outgoing)); diff != "" {
		t.Errorf("Detail(route).Outgoing diff (-want +got):\n%s", diff)
	}
	wantMissing := []MissingRef{
		{KindID: "core/Service", Kind: "Service", Namespace: "default", Name: "does-not-exist", Relation: "backendRefs"},
	}
	if diff := cmp.Diff(wantMissing, route.Missing); diff != "" {
		t.Errorf("Detail(route).Missing diff (-want +got):\n%s", diff)
	}

	pod, ok := s.Detail("pod-web-7d4b9c-abcde")
	if !ok {
		t.Fatalf("Detail(%q) not found", "pod-web-7d4b9c-abcde")
	}
	if diff := cmp.Diff([]string{" -> ReplicaSet/web-7d4b9c"}, linkNames(pod.Owners)); diff != "" {
		t.Errorf("Detail(pod).Owners diff (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"selector -> Service/web"}, linkNames(pod.Incoming)); diff != "" {
		t.Errorf("Detail(pod).Incoming diff (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"nodeName -> Node/worker-1"}, linkNames(pod.Outgoing)); diff != "" {
		t.Errorf("Detail(pod).Outgoing diff (-want +got):\n%s", diff)
	}
}

func TestDetailOfUnknownResource(t *testing.T) {
	s := New()
	if _, ok := s.Detail("no-such-uid"); ok {
		t.Errorf("Detail(%q) found a resource in an empty store", "no-such-uid")
	}
}

func TestContainerDetail(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: web}
spec:
  initContainers:
  - {name: setup, image: "busybox:1.36"}
  containers:
  - name: app
    image: nginx:1.27
    ports:
    - {containerPort: 80}
status:
  phase: Running
  initContainerStatuses:
  - {name: setup, ready: true, state: {terminated: {exitCode: 0, reason: Completed}}}
  containerStatuses:
  - {name: app, ready: false, restartCount: 3, state: {waiting: {reason: CrashLoopBackOff}}}
`)

	got, ok := s.Container("pod-web", "app")
	if !ok {
		t.Fatalf("Container(%q, %q) not found", "pod-web", "app")
	}
	want := ContainerDetail{
		Container: Container{Name: "app", Image: "nginx:1.27", Health: "red", State: "waiting", Reason: "CrashLoopBackOff", Restarts: 3},
		YAML:      "image: nginx:1.27\nname: app\nports:\n- containerPort: 80\n",
		StatusYAML: `name: app
ready: false
restartCount: 3
state:
  waiting:
    reason: CrashLoopBackOff
`,
	}
	if diff := cmp.Diff(want, got, cmpopts.IgnoreFields(ContainerDetail{}, "Pod")); diff != "" {
		t.Errorf("Container(%q, %q) diff (-want +got):\n%s", "pod-web", "app", diff)
	}
	if got.Pod.UID != "pod-web" {
		t.Errorf("Container(%q, %q).Pod.UID = %q, want %q", "pod-web", "app", got.Pod.UID, "pod-web")
	}

	initContainer, ok := s.Container("pod-web", "setup")
	if !ok || !initContainer.Container.Init {
		t.Errorf("Container(%q, %q) = found %t, init %t; want the init container", "pod-web", "setup", ok, initContainer.Container.Init)
	}
	if _, ok := s.Container("pod-web", "no-such-container"); ok {
		t.Errorf("Container(%q, %q) found a container that does not exist", "pod-web", "no-such-container")
	}
	if _, ok := s.Container("no-such-pod", "app"); ok {
		t.Errorf("Container(%q, %q) found a container of a pod that does not exist", "no-such-pod", "app")
	}
}

func TestOverview(t *testing.T) {
	s := New()
	kinds := []Kind{
		{Version: "v1", Kind: "Namespace"},
		{Version: "v1", Kind: "Node"},
		{Version: "v1", Kind: "Pod", Namespaced: true},
		{Version: "v1", Kind: "ConfigMap", Namespaced: true},
		{Group: "apps", Version: "v1", Kind: "Deployment", Namespaced: true},
		{Group: "storage.k8s.io", Version: "v1", Kind: "StorageClass"},
		{Group: "example.io", Version: "v1", Kind: "Widget", Namespaced: true},
	}
	for _, k := range kinds {
		s.AddKind(k)
	}
	add(t, s, nodeWorker1, `
apiVersion: v1
kind: Namespace
metadata: {name: default}
status: {phase: Active}
`, `
apiVersion: v1
kind: Namespace
metadata: {name: doomed}
status: {phase: Terminating}
`, `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: fast}
`, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: settings}
`, `
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: starting}
status: {phase: Pending}
`, `
apiVersion: v1
kind: Pod
metadata: {namespace: doomed, name: broken}
status: {phase: Failed}
`)
	for _, k := range kinds {
		if k.Kind != "Widget" {
			s.MarkSynced(k.ID())
		}
	}
	s.SetKindError("example.io/Widget", "widgets.example.io is forbidden")

	got := s.Overview(OverviewOptions{})
	want := Overview{
		Sync: Sync{
			Ready:       true,
			KindsTotal:  7,
			KindsSynced: 6,
			Errors:      []KindError{{KindID: "example.io/Widget", Message: "widgets.example.io is forbidden"}},
		},
		Health: Rollup{Green: 4, Yellow: 2, Red: 1},
		Kinds: []KindSummary{
			{KindID: "core/Namespace", Group: "core", Version: "v1", Kind: "Namespace", Count: 2, Rollup: Rollup{Green: 1, Yellow: 1}},
			{KindID: "core/Node", Group: "core", Version: "v1", Kind: "Node", Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "apps/Deployment", Group: "apps", Version: "v1", Kind: "Deployment", Namespaced: true},
			{KindID: "core/Pod", Group: "core", Version: "v1", Kind: "Pod", Namespaced: true, Count: 2, Rollup: Rollup{Yellow: 1, Red: 1}},
			{KindID: "core/ConfigMap", Group: "core", Version: "v1", Kind: "ConfigMap", Namespaced: true, Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "storage.k8s.io/StorageClass", Group: "storage.k8s.io", Version: "v1", Kind: "StorageClass", Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "example.io/Widget", Group: "example.io", Version: "v1", Kind: "Widget", Namespaced: true},
		},
		Namespaces: []NamespaceSummary{
			{Name: "default", UID: "namespace-default", Health: "green", Reason: "Active", Count: 2, Rollup: Rollup{Green: 1, Yellow: 1}},
			{Name: "doomed", UID: "namespace-doomed", Health: "yellow", Reason: "Terminating", Count: 1, Rollup: Rollup{Red: 1}},
		},
		ClusterScoped: Area{Count: 1, Rollup: Rollup{Green: 1}},
		Nodes:         Area{Count: 1, Rollup: Rollup{Green: 1}},
	}
	if diff := cmp.Diff(want, got, cmpopts.IgnoreFields(Overview{}, "Revision")); diff != "" {
		t.Errorf("Overview() diff (-want +got):\n%s", diff)
	}
}

func TestOverviewIsNotReadyUntilEveryKindHasLoaded(t *testing.T) {
	s := New()
	if s.Overview(OverviewOptions{}).Sync.Ready {
		t.Errorf("Overview().Sync.Ready = true before any resource type is known, want false")
	}
	pods := Kind{Version: "v1", Kind: "Pod", Namespaced: true}
	nodes := Kind{Version: "v1", Kind: "Node"}
	s.AddKind(pods)
	s.AddKind(nodes)
	s.MarkSynced(pods.ID())
	if s.Overview(OverviewOptions{}).Sync.Ready {
		t.Errorf("Overview().Sync.Ready = true while nodes are still loading, want false")
	}
	s.MarkSynced(nodes.ID())
	if !s.Overview(OverviewOptions{}).Sync.Ready {
		t.Errorf("Overview().Sync.Ready = false after every resource type loaded, want true")
	}
}

func TestOverviewListsNamespaceWhoseObjectIsNotLoaded(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: orphaned, name: settings}
`)

	got := s.Overview(OverviewOptions{}).Namespaces
	want := []NamespaceSummary{{Name: "orphaned", Health: "green", Count: 1, Rollup: Rollup{Green: 1}}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Overview().Namespaces diff (-want +got):\n%s", diff)
	}
}

func TestSubscriptionReportsChanges(t *testing.T) {
	s := New()
	sub := s.Subscribe()
	defer sub.Close()

	add(t, s, podWeb, nodeWorker1)
	s.Delete("node-worker-1")

	select {
	case <-sub.Ready():
	default:
		t.Fatalf("subscription is not ready after changes were made")
	}
	got := sub.Take()
	want := Change{
		Revision: s.Overview(OverviewOptions{}).Revision,
		Changed:  []string{"pod-web-7d4b9c-abcde"},
		Deleted:  []string{"node-worker-1"},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Take() diff (-want +got):\n%s", diff)
	}

	again := sub.Take()
	if len(again.Changed) != 0 || len(again.Deleted) != 0 || again.Overflow {
		t.Errorf("second Take() = %+v, want no pending changes", again)
	}
	select {
	case <-sub.Ready():
		t.Errorf("subscription is ready although nothing changed since the last Take()")
	default:
	}
}

func TestSubscriptionCollapsesLargeBurstsIntoOverflow(t *testing.T) {
	s := New()
	sub := s.Subscribe()
	defer sub.Close()

	for i := range 501 {
		add(t, s, fmt.Sprintf(`
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: cm-%03d}
`, i))
	}

	got := sub.Take()
	if !got.Overflow || len(got.Changed) != 0 || len(got.Deleted) != 0 {
		t.Errorf("Take() after 501 changes = overflow %t with %d changed and %d deleted, want overflow with empty lists", got.Overflow, len(got.Changed), len(got.Deleted))
	}
}

func TestRevisionAdvancesOnlyOnRealChanges(t *testing.T) {
	s := New()
	add(t, s, podWeb)
	before := s.Overview(OverviewOptions{}).Revision

	add(t, s, podWeb) // Same resourceVersion: a relist, not a change.
	if got := s.Overview(OverviewOptions{}).Revision; got != before {
		t.Errorf("revision after re-adding an unchanged resource = %d, want %d", got, before)
	}

	add(t, s, strings.Replace(podWeb, "labels: {app: web}", "labels: {app: web}\n  resourceVersion: \"2\"", 1))
	if got := s.Overview(OverviewOptions{}).Revision; got <= before {
		t.Errorf("revision after a changed resource = %d, want more than %d", got, before)
	}
}

func TestUpsertUpdatesRelationships(t *testing.T) {
	s := New()
	add(t, s, nodeWorker1, `
apiVersion: v1
kind: Node
metadata: {name: worker-2}
status: {conditions: [{type: Ready, status: "True"}]}
`, `
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: mover, resourceVersion: "1"}
spec: {nodeName: worker-1}
`)
	add(t, s, `
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: mover, resourceVersion: "2"}
spec: {nodeName: worker-2}
`)

	if got := names(s.List(Query{Scope: ScopePodsOnNode, Target: "worker-1"})); len(got) != 0 {
		t.Errorf("List(pods on worker-1) = %v after the pod moved, want none", got)
	}
	if diff := cmp.Diff([]string{"Pod/mover"}, names(s.List(Query{Scope: ScopePodsOnNode, Target: "worker-2"}))); diff != "" {
		t.Errorf("List(pods on worker-2) diff (-want +got):\n%s", diff)
	}
}

func TestPruneKindDropsResourcesThatVanished(t *testing.T) {
	s := New()
	configMaps := Kind{Version: "v1", Kind: "ConfigMap", Namespaced: true}
	s.AddKind(configMaps)
	add(t, s, deploymentWeb, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: old}
`, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: kept}
`)
	sub := s.Subscribe()
	defer sub.Close()

	// A fresh listing of the cluster finds one new config map and no longer
	// finds an old one.
	add(t, s, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: kept}
`, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: new}
`)
	s.PruneKind(configMaps.ID(), []string{"configmap-kept", "configmap-new"})

	got := s.List(Query{Scope: ScopeNamespace, Target: "default"})
	want := []string{"Deployment/web", "ConfigMap/kept", "ConfigMap/new"}
	if diff := cmp.Diff(want, names(got)); diff != "" {
		t.Errorf("List(namespace default) after PruneKind diff (-want +got):\n%s", diff)
	}
	change := sub.Take()
	wantChange := Change{Revision: change.Revision, Changed: []string{"configmap-new"}, Deleted: []string{"configmap-old"}}
	if diff := cmp.Diff(wantChange, change); diff != "" {
		t.Errorf("Take() after PruneKind diff (-want +got):\n%s", diff)
	}
	if got := s.Overview(OverviewOptions{}).Sync.KindsSynced; got != 1 {
		t.Errorf("Overview().Sync.KindsSynced after PruneKind = %d, want 1", got)
	}
}

func TestPruneKindClearsAnEarlierLoadingError(t *testing.T) {
	s := New()
	widgets := Kind{Group: "example.io", Version: "v1", Kind: "Widget", Namespaced: true}
	s.AddKind(widgets)
	s.SetKindError(widgets.ID(), "widgets.example.io is forbidden")

	s.PruneKind(widgets.ID(), nil)

	if got := s.Overview(OverviewOptions{}).Sync.Errors; len(got) != 0 {
		t.Errorf("Overview().Sync.Errors after a successful load = %+v, want none", got)
	}
}

func TestRemoveKindDropsItsResources(t *testing.T) {
	s := New()
	widgets := Kind{Group: "example.io", Version: "v1", Kind: "Widget", Namespaced: true}
	s.AddKind(widgets)
	add(t, s, deploymentWeb, `
apiVersion: example.io/v1
kind: Widget
metadata: {namespace: default, name: gadget}
`)

	s.RemoveKind(widgets.ID())

	if diff := cmp.Diff([]string{"Deployment/web"}, names(s.List(Query{Scope: ScopeAll}))); diff != "" {
		t.Errorf("List(all) after RemoveKind diff (-want +got):\n%s", diff)
	}
	if got := len(s.Overview(OverviewOptions{}).Kinds); got != 0 {
		t.Errorf("Overview().Kinds has %d entries after RemoveKind, want 0", got)
	}
}

func TestUpsertRejectsObjectWithoutIdentity(t *testing.T) {
	s := New()
	err := s.Upsert(Kind{Version: "v1", Kind: "ConfigMap", Namespaced: true}, map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata":   map[string]any{"name": "nameless"},
	})
	if err == nil {
		t.Errorf("Upsert(object without uid) succeeded, want an error")
	}
}
