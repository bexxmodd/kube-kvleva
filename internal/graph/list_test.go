package graph

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"sigs.k8s.io/yaml"
)

// parse decodes a YAML manifest and fills in the bookkeeping fields every
// real object has, so that test manifests can stay short. The uid defaults
// to "<kind>-<name>" in lower case.
func parse(t *testing.T, manifest string) (Kind, map[string]any) {
	t.Helper()
	var obj map[string]any
	if err := yaml.Unmarshal([]byte(manifest), &obj); err != nil {
		t.Fatalf("parsing test manifest: %v\n%s", err, manifest)
	}
	metadata, _ := obj["metadata"].(map[string]any)
	if metadata == nil {
		t.Fatalf("test manifest has no metadata:\n%s", manifest)
	}
	kind, _ := obj["kind"].(string)
	name, _ := metadata["name"].(string)
	if _, ok := metadata["uid"]; !ok {
		metadata["uid"] = strings.ToLower(kind) + "-" + name
	}
	if _, ok := metadata["resourceVersion"]; !ok {
		metadata["resourceVersion"] = "1"
	}
	apiVersion, _ := obj["apiVersion"].(string)
	group, version, found := strings.Cut(apiVersion, "/")
	if !found {
		group, version = "", apiVersion
	}
	_, namespaced := metadata["namespace"]
	return Kind{Group: group, Version: version, Kind: kind, Namespaced: namespaced}, obj
}

// add stores the given manifests.
func add(t *testing.T, s *Store, manifests ...string) {
	t.Helper()
	for _, manifest := range manifests {
		kind, obj := parse(t, manifest)
		if err := s.Upsert(kind, obj); err != nil {
			t.Fatalf("Upsert failed: %v\n%s", err, manifest)
		}
	}
}

// names lists the items of a page as "Kind/name".
func names(page Page) []string {
	var result []string
	for _, item := range page.Items {
		result = append(result, item.Kind+"/"+item.Name)
	}
	return result
}

// linkNames lists links as "relation -> Kind/name".
func linkNames(links []Link) []string {
	var result []string
	for _, l := range links {
		result = append(result, l.Relation+" -> "+l.Kind+"/"+l.Name)
	}
	return result
}

const (
	deploymentWeb = `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: web, generation: 1}
spec: {replicas: 1}
status: {observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1}
`
	replicaSetWeb = `
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  namespace: default
  name: web-7d4b9c
  ownerReferences:
  - {apiVersion: apps/v1, kind: Deployment, name: web, uid: deployment-web, controller: true}
spec: {replicas: 1}
status: {replicas: 1, readyReplicas: 1}
`
	podWeb = `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: web-7d4b9c-abcde
  labels: {app: web}
  ownerReferences:
  - {apiVersion: apps/v1, kind: ReplicaSet, name: web-7d4b9c, uid: replicaset-web-7d4b9c, controller: true}
spec:
  nodeName: worker-1
  containers:
  - {name: app, image: "nginx:1.27"}
  - {name: sidecar, image: "envoy:1.30"}
status:
  phase: Running
  conditions:
  - {type: Ready, status: "True"}
  containerStatuses:
  - {name: app, ready: true, state: {running: {}}}
  - {name: sidecar, ready: true, state: {running: {}}}
`
	nodeWorker1 = `
apiVersion: v1
kind: Node
metadata: {name: worker-1}
status:
  conditions:
  - {type: Ready, status: "True"}
`
)

func TestListNestsResourcesInsideTheirOwner(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb, podWeb)

	top := s.List(Query{Scope: ScopeNamespace, Target: "default"})
	if diff := cmp.Diff([]string{"Deployment/web"}, names(top)); diff != "" {
		t.Fatalf("List(namespace default) diff (-want +got):\n%s", diff)
	}
	deployment := top.Items[0]
	if deployment.ChildCount != 1 {
		t.Errorf("List(namespace default) deployment ChildCount = %d, want 1", deployment.ChildCount)
	}
	if diff := cmp.Diff(Rollup{Green: 3}, deployment.Rollup); diff != "" {
		t.Errorf("List(namespace default) deployment Rollup diff (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"ns:default"}, deployment.Path); diff != "" {
		t.Errorf("List(namespace default) deployment Path diff (-want +got):\n%s", diff)
	}

	inDeployment := s.List(Query{Scope: ScopeChildren, Target: "deployment-web"})
	if diff := cmp.Diff([]string{"ReplicaSet/web-7d4b9c"}, names(inDeployment)); diff != "" {
		t.Fatalf("List(children of deployment) diff (-want +got):\n%s", diff)
	}

	inReplicaSet := s.List(Query{Scope: ScopeChildren, Target: "replicaset-web-7d4b9c"})
	if diff := cmp.Diff([]string{"Pod/web-7d4b9c-abcde"}, names(inReplicaSet)); diff != "" {
		t.Fatalf("List(children of replica set) diff (-want +got):\n%s", diff)
	}
	wantPath := []string{"ns:default", "deployment-web", "replicaset-web-7d4b9c"}
	if diff := cmp.Diff(wantPath, inReplicaSet.Items[0].Path); diff != "" {
		t.Errorf("List(children of replica set) pod Path diff (-want +got):\n%s", diff)
	}
}

func TestListNestingDoesNotDependOnArrivalOrder(t *testing.T) {
	s := New()
	add(t, s, podWeb, replicaSetWeb, deploymentWeb)

	got := s.List(Query{Scope: ScopeNamespace, Target: "default"})
	if diff := cmp.Diff([]string{"Deployment/web"}, names(got)); diff != "" {
		t.Errorf("List(namespace default) diff (-want +got):\n%s", diff)
	}
}

func TestListPodSummaryCarriesContainersAndNode(t *testing.T) {
	s := New()
	add(t, s, podWeb)

	page := s.List(Query{Scope: ScopeNamespace, Target: "default"})
	if len(page.Items) != 1 {
		t.Fatalf("List(namespace default) returned %d items, want 1", len(page.Items))
	}
	pod := page.Items[0]
	if pod.Node != "worker-1" {
		t.Errorf("pod summary Node = %q, want %q", pod.Node, "worker-1")
	}
	want := []Container{
		{Name: "app", Image: "nginx:1.27", Health: "green", State: "running", Ready: true},
		{Name: "sidecar", Image: "envoy:1.30", Health: "green", State: "running", Ready: true},
	}
	if diff := cmp.Diff(want, pod.Containers); diff != "" {
		t.Errorf("pod summary Containers diff (-want +got):\n%s", diff)
	}
}

func TestListKeepsResourceOwnedFromOutsideItsNamespaceAtTopLevel(t *testing.T) {
	s := New()
	add(t, s, nodeWorker1, `
apiVersion: v1
kind: Pod
metadata:
  namespace: kube-system
  name: etcd-worker-1
  ownerReferences:
  - {apiVersion: v1, kind: Node, name: worker-1, uid: node-worker-1, controller: true}
spec:
  nodeName: worker-1
status: {phase: Running, conditions: [{type: Ready, status: "True"}]}
`)

	page := s.List(Query{Scope: ScopeNamespace, Target: "kube-system"})
	if diff := cmp.Diff([]string{"Pod/etcd-worker-1"}, names(page)); diff != "" {
		t.Fatalf("List(namespace kube-system) diff (-want +got):\n%s", diff)
	}
	// The node is reached both as owner and through nodeName; that is one
	// reference, not two.
	detail, ok := s.Detail("pod-etcd-worker-1")
	if !ok {
		t.Fatalf("Detail(%q) not found", "pod-etcd-worker-1")
	}
	want := []string{"ownerReferences -> Node/worker-1"}
	if diff := cmp.Diff(want, linkNames(detail.Outgoing)); diff != "" {
		t.Errorf("Detail(%q).Outgoing diff (-want +got):\n%s", "pod-etcd-worker-1", diff)
	}
	nodes := s.List(Query{Scope: ScopeNodes})
	if got := nodes.Items[0].ChildCount; got != 0 {
		t.Errorf("List(nodes) node ChildCount = %d, want 0 because the pod is not nested in it", got)
	}
}

func TestListKeepsResourceWithUnknownOwnerAtTopLevel(t *testing.T) {
	s := New()
	add(t, s, podWeb)

	got := s.List(Query{Scope: ScopeNamespace, Target: "default"})
	if diff := cmp.Diff([]string{"Pod/web-7d4b9c-abcde"}, names(got)); diff != "" {
		t.Errorf("List(namespace default) diff (-want +got):\n%s", diff)
	}
}

func TestDetailResolvesReferences(t *testing.T) {
	const (
		gatewayClass = `
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: {name: kvleva}
`
		gateway = `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {namespace: infra, name: shared}
spec: {gatewayClassName: kvleva}
`
		service = `
apiVersion: v1
kind: Service
metadata: {namespace: default, name: web}
spec:
  selector: {app: web}
`
	)
	tests := []struct {
		name      string
		manifests []string
		source    string
		want      []string
	}{
		{
			name:      "cluster_scoped_target",
			manifests: []string{gatewayClass, gateway},
			source:    "gateway-shared",
			want:      []string{"gatewayClassName -> GatewayClass/kvleva"},
		},
		{
			name: "target_in_same_namespace",
			manifests: []string{service, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
spec:
  rules:
  - backendRefs:
    - {name: web, port: 80}
`},
			source: "httproute-web",
			want:   []string{"backendRefs -> Service/web"},
		},
		{
			name: "target_in_another_namespace",
			manifests: []string{gateway, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
spec:
  parentRefs:
  - {namespace: infra, name: shared}
`},
			source: "httproute-web",
			want:   []string{"parentRefs -> Gateway/shared"},
		},
		{
			name: "same_name_in_wrong_namespace_is_not_the_target",
			manifests: []string{gateway, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
spec:
  parentRefs:
  - {name: shared}
`},
			source: "httproute-web",
		},
		{
			name: "same_kind_name_in_another_api_group_is_not_the_target",
			manifests: []string{`
apiVersion: example.io/v1
kind: Gateway
metadata: {namespace: default, name: shared}
`, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
spec:
  parentRefs:
  - {name: shared}
`},
			source: "httproute-web",
		},
		{
			name:      "label_selector",
			manifests: []string{service, deploymentWeb, replicaSetWeb, podWeb},
			source:    "service-web",
			want:      []string{"selector -> Pod/web-7d4b9c-abcde"},
		},
		{
			name: "label_selector_stays_inside_its_namespace",
			manifests: []string{service, `
apiVersion: v1
kind: Pod
metadata: {namespace: other, name: web-elsewhere, labels: {app: web}}
`},
			source: "service-web",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			add(t, s, tc.manifests...)
			detail, ok := s.Detail(tc.source)
			if !ok {
				t.Fatalf("Detail(%q) not found", tc.source)
			}
			if diff := cmp.Diff(tc.want, linkNames(detail.Outgoing)); diff != "" {
				t.Errorf("Detail(%q).Outgoing diff (-want +got):\n%s", tc.source, diff)
			}
		})
	}
}

func TestDetailReferenceCarriesThePathOfItsTarget(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb, podWeb, `
apiVersion: v1
kind: Service
metadata: {namespace: default, name: web}
spec:
  selector: {app: web}
`)

	detail, ok := s.Detail("service-web")
	if !ok {
		t.Fatalf("Detail(%q) not found", "service-web")
	}
	want := []Link{{
		UID:       "pod-web-7d4b9c-abcde",
		KindID:    "core/Pod",
		Kind:      "Pod",
		Namespace: "default",
		Name:      "web-7d4b9c-abcde",
		Health:    "green",
		Path:      []string{"ns:default", "deployment-web", "replicaset-web-7d4b9c"},
		Relation:  "selector",
	}}
	if diff := cmp.Diff(want, detail.Outgoing); diff != "" {
		t.Errorf("Detail(%q).Outgoing diff (-want +got):\n%s", "service-web", diff)
	}
}

func TestDetailCapsReferencesPerResource(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: v1
kind: Service
metadata: {namespace: default, name: web}
spec:
  selector: {app: web}
`)
	for i := range 1010 {
		add(t, s, fmt.Sprintf(`
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: web-%04d, labels: {app: web}}
`, i))
	}

	detail, ok := s.Detail("service-web")
	if !ok {
		t.Fatalf("Detail(%q) not found", "service-web")
	}
	if got := len(detail.Outgoing); got != 1000 {
		t.Errorf("Detail(%q) lists %d references to the 1010 selected pods, want the cap of 1000", "service-web", got)
	}
}

func TestListOrdersResourcesByRole(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: settings}
`, `
apiVersion: example.io/v1
kind: Widget
metadata: {namespace: default, name: gadget}
`, `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: web}
`, `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: api}
`, `
apiVersion: v1
kind: Service
metadata: {namespace: default, name: web}
`, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {namespace: default, name: web}
`, `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {namespace: default, name: edge}
`)

	got := s.List(Query{Scope: ScopeNamespace, Target: "default"})
	want := []string{
		"Gateway/edge",
		"HTTPRoute/web",
		"Service/web",
		"Deployment/api",
		"Deployment/web",
		"ConfigMap/settings",
		"Widget/gadget",
	}
	if diff := cmp.Diff(want, names(got)); diff != "" {
		t.Errorf("List(namespace default) diff (-want +got):\n%s", diff)
	}
}

func TestListPaginates(t *testing.T) {
	s := New()
	for i := range 250 {
		add(t, s, fmt.Sprintf(`
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: cm-%03d}
`, i))
	}
	tests := []struct {
		name      string
		limit     int
		offset    int
		wantCount int
		wantFirst string
		wantLimit int
	}{
		{name: "first_page_uses_default_size", wantCount: 100, wantFirst: "cm-000", wantLimit: 100},
		{name: "second_page", offset: 100, wantCount: 100, wantFirst: "cm-100", wantLimit: 100},
		{name: "last_page_is_short", offset: 200, wantCount: 50, wantFirst: "cm-200", wantLimit: 100},
		{name: "custom_size", limit: 10, offset: 5, wantCount: 10, wantFirst: "cm-005", wantLimit: 10},
		{name: "size_is_capped", limit: 100000, wantCount: 250, wantFirst: "cm-000", wantLimit: 500},
		{name: "offset_past_the_end", offset: 1000, wantCount: 0, wantLimit: 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := Query{Scope: ScopeNamespace, Target: "default", Limit: tc.limit, Offset: tc.offset}
			got := s.List(q)
			if got.Total != 250 {
				t.Errorf("List(%+v).Total = %d, want 250", q, got.Total)
			}
			if got.Limit != tc.wantLimit || got.Offset != tc.offset {
				t.Errorf("List(%+v) reports limit %d offset %d, want limit %d offset %d", q, got.Limit, got.Offset, tc.wantLimit, tc.offset)
			}
			if len(got.Items) != tc.wantCount {
				t.Fatalf("List(%+v) returned %d items, want %d", q, len(got.Items), tc.wantCount)
			}
			if tc.wantCount > 0 && got.Items[0].Name != tc.wantFirst {
				t.Errorf("List(%+v) first item = %q, want %q", q, got.Items[0].Name, tc.wantFirst)
			}
		})
	}
}

func TestListFilters(t *testing.T) {
	const (
		failedPod = `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: checkout-api-1
  ownerReferences:
  - {apiVersion: apps/v1, kind: ReplicaSet, name: checkout-api-rs, uid: replicaset-checkout-api-rs, controller: true}
status: {phase: Failed}
`
		checkoutReplicaSet = `
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  namespace: default
  name: checkout-api-rs
  ownerReferences:
  - {apiVersion: apps/v1, kind: Deployment, name: checkout-api, uid: deployment-checkout-api, controller: true}
spec: {replicas: 0}
`
		checkoutDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: checkout-api}
spec: {replicas: 0}
`
		billingDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: billing-worker}
spec: {replicas: 0}
`
		configMap = `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: settings}
`
	)
	all := []string{failedPod, checkoutReplicaSet, checkoutDeployment, billingDeployment, configMap}
	tests := []struct {
		name  string
		query Query
		want  []string
	}{
		{
			name:  "no_filter",
			query: Query{Scope: ScopeNamespace, Target: "default"},
			want:  []string{"Deployment/billing-worker", "Deployment/checkout-api", "ConfigMap/settings"},
		},
		{
			name:  "resource_type_filtered_out",
			query: Query{Scope: ScopeNamespace, Target: "default", HideKinds: []string{"core/ConfigMap"}},
			want:  []string{"Deployment/billing-worker", "Deployment/checkout-api"},
		},
		{
			name:  "filtering_out_intermediate_type_promotes_its_contents",
			query: Query{Scope: ScopeChildren, Target: "deployment-checkout-api", HideKinds: []string{"apps/ReplicaSet"}},
			want:  []string{"Pod/checkout-api-1"},
		},
		{
			name:  "filtering_out_top_level_type_promotes_its_contents",
			query: Query{Scope: ScopeNamespace, Target: "default", HideKinds: []string{"apps/Deployment", "core/ConfigMap"}},
			want:  []string{"ReplicaSet/checkout-api-rs"},
		},
		{
			name:  "health_keeps_the_path_to_failing_resources",
			query: Query{Scope: ScopeNamespace, Target: "default", Health: []string{"red"}},
			want:  []string{"Deployment/checkout-api"},
		},
		{
			name:  "health_applies_to_children_too",
			query: Query{Scope: ScopeChildren, Target: "replicaset-checkout-api-rs", Health: []string{"green", "yellow"}},
		},
		{
			name:  "search_ignores_case",
			query: Query{Scope: ScopeNamespace, Target: "default", Text: "CHECK"},
			want:  []string{"Deployment/checkout-api"},
		},
		{
			name:  "search_finds_nested_resources_through_their_owner",
			query: Query{Scope: ScopeNamespace, Target: "default", Text: "api-1"},
			want:  []string{"Deployment/checkout-api"},
		},
		{
			name:  "flat_search_lists_every_match",
			query: Query{Scope: ScopeAll, Text: "checkout"},
			want:  []string{"Deployment/checkout-api", "ReplicaSet/checkout-api-rs", "Pod/checkout-api-1"},
		},
		{
			name:  "flat_search_combines_filters",
			query: Query{Scope: ScopeAll, Text: "checkout", Health: []string{"red"}},
			want:  []string{"Pod/checkout-api-1"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			add(t, s, all...)
			got := s.List(tc.query)
			if diff := cmp.Diff(tc.want, names(got)); diff != "" {
				t.Errorf("List(%+v) diff (-want +got):\n%s", tc.query, diff)
			}
			if got.Total != len(tc.want) {
				t.Errorf("List(%+v).Total = %d, want %d", tc.query, got.Total, len(tc.want))
			}
		})
	}
}

func TestListReportsWhetherTheResourceItselfMatched(t *testing.T) {
	s := New()
	add(t, s, `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: web}
spec: {replicas: 0}
`, `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: web-1
  ownerReferences:
  - {apiVersion: apps/v1, kind: Deployment, name: web, uid: deployment-web, controller: true}
status: {phase: Failed}
`)

	parents := s.List(Query{Scope: ScopeNamespace, Target: "default", Health: []string{"red"}})
	if len(parents.Items) != 1 || parents.Items[0].SelfMatch {
		t.Errorf("List(red) = %v with SelfMatch %v, want the green deployment with SelfMatch false", names(parents), selfMatches(parents))
	}
	children := s.List(Query{Scope: ScopeChildren, Target: "deployment-web", Health: []string{"red"}})
	if len(children.Items) != 1 || !children.Items[0].SelfMatch {
		t.Errorf("List(red children) = %v with SelfMatch %v, want the red pod with SelfMatch true", names(children), selfMatches(children))
	}
	if got := parents.Items[0].ChildCount; got != 1 {
		t.Errorf("List(red) deployment ChildCount = %d, want 1", got)
	}
}

func selfMatches(page Page) []bool {
	var result []bool
	for _, item := range page.Items {
		result = append(result, item.SelfMatch)
	}
	return result
}

func TestListScopes(t *testing.T) {
	manifests := []string{
		nodeWorker1,
		deploymentWeb, replicaSetWeb, podWeb,
		`
apiVersion: v1
kind: Namespace
metadata: {name: default}
status: {phase: Active}
`, `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: fast}
`, `
apiVersion: v1
kind: Pod
metadata: {namespace: other, name: lonely}
spec: {nodeName: worker-2}
`,
	}
	tests := []struct {
		name  string
		query Query
		want  []string
	}{
		{
			name:  "cluster_wide_area_excludes_namespaces_and_nodes",
			query: Query{Scope: ScopeCluster},
			want:  []string{"StorageClass/fast"},
		},
		{
			name:  "nodes",
			query: Query{Scope: ScopeNodes},
			want:  []string{"Node/worker-1"},
		},
		{
			name:  "pods_on_a_node",
			query: Query{Scope: ScopePodsOnNode, Target: "worker-1"},
			want:  []string{"Pod/web-7d4b9c-abcde"},
		},
		{
			name:  "namespace_only_lists_its_own_resources",
			query: Query{Scope: ScopeNamespace, Target: "other"},
			want:  []string{"Pod/lonely"},
		},
		{
			name:  "children_of_unknown_resource",
			query: Query{Scope: ScopeChildren, Target: "no-such-uid"},
		},
		{
			name:  "everything",
			query: Query{Scope: ScopeAll},
			want: []string{
				"Namespace/default",
				"Node/worker-1",
				"Deployment/web",
				"ReplicaSet/web-7d4b9c",
				"Pod/web-7d4b9c-abcde",
				"Pod/lonely",
				"StorageClass/fast",
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			add(t, s, manifests...)
			got := s.List(tc.query)
			if diff := cmp.Diff(tc.want, names(got)); diff != "" {
				t.Errorf("List(%+v) diff (-want +got):\n%s", tc.query, diff)
			}
		})
	}
}
