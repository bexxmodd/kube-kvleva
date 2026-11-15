package graph

import (
	"fmt"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
)

// The cluster in these tests came up at 17:24:13; "bootstrap" resources are
// stamped within seconds of that and "later" ones ten minutes after.
const (
	atBootstrap    = "2026-11-14T17:24:13Z"
	duringSetup    = "2026-11-14T17:24:17Z" // 4 s in: add-ons the installer applies
	endOfBootstrap = "2026-11-14T17:24:43Z" // 30 s in
	justAfter      = "2026-11-14T17:24:44Z" // 31 s in
	later          = "2026-11-14T17:34:13Z"

	kubeSystemNamespace = `
apiVersion: v1
kind: Namespace
metadata: {name: kube-system, creationTimestamp: "` + atBootstrap + `"}
status: {phase: Active}
`
)

func TestListHidesSystemResources(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		// wantSystem says whether the resource is a system resource, which
		// is hidden unless asked for.
		wantSystem bool
	}{
		// Everything in the system namespaces, and those namespaces.
		{
			name:       "workload_in_kube_system",
			manifest:   `{apiVersion: apps/v1, kind: Deployment, metadata: {namespace: kube-system, name: coredns, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "config_in_kube_public",
			manifest:   `{apiVersion: v1, kind: ConfigMap, metadata: {namespace: kube-public, name: cluster-info, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "kube_system_namespace_itself",
			manifest:   `{apiVersion: v1, kind: Namespace, metadata: {name: kube-node-lease, creationTimestamp: "` + atBootstrap + `"}}`,
			wantSystem: true,
		},
		{
			name:       "storage_provisioner_namespace",
			manifest:   `{apiVersion: v1, kind: Namespace, metadata: {name: local-path-storage, creationTimestamp: "` + duringSetup + `"}}`,
			wantSystem: true,
		},
		{
			name:       "workload_in_storage_provisioner_namespace",
			manifest:   `{apiVersion: apps/v1, kind: Deployment, metadata: {namespace: local-path-storage, name: local-path-provisioner, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},

		// What its users deploy.
		{
			name:     "default_namespace",
			manifest: `{apiVersion: v1, kind: Namespace, metadata: {name: default, creationTimestamp: "` + atBootstrap + `"}}`,
		},
		{
			name:     "user_workload_in_default_namespace",
			manifest: `{apiVersion: apps/v1, kind: Deployment, metadata: {namespace: default, name: web, creationTimestamp: "` + later + `"}}`,
		},
		{
			name:     "user_namespace_created_right_after_the_cluster",
			manifest: `{apiVersion: v1, kind: Namespace, metadata: {name: shop, creationTimestamp: "` + duringSetup + `"}}`,
		},
		{
			name:     "user_workload_deployed_right_after_the_cluster",
			manifest: `{apiVersion: apps/v1, kind: Deployment, metadata: {namespace: shop, name: web, creationTimestamp: "` + duringSetup + `"}}`,
		},
		{
			name:     "user_service_account",
			manifest: `{apiVersion: v1, kind: ServiceAccount, metadata: {namespace: shop, name: builder, creationTimestamp: "` + later + `"}}`,
		},
		{
			name:     "node",
			manifest: `{apiVersion: v1, kind: Node, metadata: {name: worker-1, creationTimestamp: "` + atBootstrap + `"}}`,
		},

		// Cluster-wide resources installed while the cluster was created.
		{
			name:       "network_plugin_role_installed_with_the_cluster",
			manifest:   `{apiVersion: rbac.authorization.k8s.io/v1, kind: ClusterRole, metadata: {name: kindnet, creationTimestamp: "` + duringSetup + `"}}`,
			wantSystem: true,
		},
		{
			name:       "storage_class_installed_with_the_cluster",
			manifest:   `{apiVersion: storage.k8s.io/v1, kind: StorageClass, metadata: {name: standard, creationTimestamp: "` + duringSetup + `"}}`,
			wantSystem: true,
		},
		{
			name:       "cluster_wide_resource_at_the_end_of_bootstrap",
			manifest:   `{apiVersion: storage.k8s.io/v1, kind: StorageClass, metadata: {name: slow-installer, creationTimestamp: "` + endOfBootstrap + `"}}`,
			wantSystem: true,
		},
		{
			name:     "cluster_wide_resource_just_after_bootstrap",
			manifest: `{apiVersion: storage.k8s.io/v1, kind: StorageClass, metadata: {name: fast, creationTimestamp: "` + justAfter + `"}}`,
		},
		{
			name:     "user_role_created_later",
			manifest: `{apiVersion: rbac.authorization.k8s.io/v1, kind: ClusterRole, metadata: {name: shop-operator, creationTimestamp: "` + later + `"}}`,
		},

		// What Kubernetes maintains by itself, whenever it was created.
		{
			name:       "built_in_role",
			manifest:   `{apiVersion: rbac.authorization.k8s.io/v1, kind: ClusterRole, metadata: {name: view, labels: {kubernetes.io/bootstrapping: rbac-defaults}, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "system_prefixed_binding",
			manifest:   `{apiVersion: rbac.authorization.k8s.io/v1, kind: ClusterRoleBinding, metadata: {name: "system:node-proxier", creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "installer_prefixed_binding",
			manifest:   `{apiVersion: rbac.authorization.k8s.io/v1, kind: ClusterRoleBinding, metadata: {name: "kubeadm:get-nodes", creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "certificate_bundle_of_a_user_namespace",
			manifest:   `{apiVersion: v1, kind: ConfigMap, metadata: {namespace: shop, name: kube-root-ca.crt, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "default_service_account_of_a_user_namespace",
			manifest:   `{apiVersion: v1, kind: ServiceAccount, metadata: {namespace: shop, name: default, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "api_server_service",
			manifest:   `{apiVersion: v1, kind: Service, metadata: {namespace: default, name: kubernetes, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "api_server_endpoints",
			manifest:   `{apiVersion: discovery.k8s.io/v1, kind: EndpointSlice, metadata: {namespace: default, name: kubernetes, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:     "user_service_named_like_the_api_server_service_elsewhere",
			manifest: `{apiVersion: v1, kind: Service, metadata: {namespace: shop, name: kubernetes, creationTimestamp: "` + later + `"}}`,
		},
		{
			name:       "allocated_service_address",
			manifest:   `{apiVersion: networking.k8s.io/v1, kind: IPAddress, metadata: {name: 10.96.12.7, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "service_address_range",
			manifest:   `{apiVersion: networking.k8s.io/v1, kind: ServiceCIDR, metadata: {name: kubernetes, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "node_storage_registration",
			manifest:   `{apiVersion: storage.k8s.io/v1, kind: CSINode, metadata: {name: worker-9, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "automatically_managed_api_service",
			manifest:   `{apiVersion: apiregistration.k8s.io/v1, kind: APIService, metadata: {name: v1.shop.example.io, labels: {kube-aggregator.kubernetes.io/automanaged: "true"}, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:     "api_service_registered_by_a_user",
			manifest: `{apiVersion: apiregistration.k8s.io/v1, kind: APIService, metadata: {name: v1beta1.metrics.k8s.io, creationTimestamp: "` + later + `"}}`,
		},
		{
			name:       "built_in_request_priority",
			manifest:   `{apiVersion: flowcontrol.apiserver.k8s.io/v1, kind: FlowSchema, metadata: {name: probes, annotations: {apf.kubernetes.io/autoupdate-spec: "true"}, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:       "system_priority_class",
			manifest:   `{apiVersion: scheduling.k8s.io/v1, kind: PriorityClass, metadata: {name: system-node-critical, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
		{
			name:     "user_priority_class",
			manifest: `{apiVersion: scheduling.k8s.io/v1, kind: PriorityClass, metadata: {name: batch-low, creationTimestamp: "` + later + `"}}`,
		},
		{
			name:       "node_certificate_request",
			manifest:   `{apiVersion: certificates.k8s.io/v1, kind: CertificateSigningRequest, metadata: {name: csr-abcde, creationTimestamp: "` + later + `"}, spec: {username: "system:node:worker-9"}}`,
			wantSystem: true,
		},
		{
			name:     "user_certificate_request",
			manifest: `{apiVersion: certificates.k8s.io/v1, kind: CertificateSigningRequest, metadata: {name: alice, creationTimestamp: "` + later + `"}, spec: {username: alice}}`,
		},
		{
			name:       "add_on_managed_by_the_platform",
			manifest:   `{apiVersion: storage.k8s.io/v1, kind: StorageClass, metadata: {name: premium, labels: {addonmanager.kubernetes.io/mode: EnsureExists}, creationTimestamp: "` + later + `"}}`,
			wantSystem: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			add(t, s, kubeSystemNamespace)
			kind, obj := parse(t, tc.manifest)
			if err := s.Upsert(kind, obj); err != nil {
				t.Fatalf("Upsert failed: %v", err)
			}
			label := kind.Kind + "/" + obj["metadata"].(map[string]any)["name"].(string)
			contains := func(q Query) bool {
				for _, name := range names(s.List(q)) {
					if name == label {
						return true
					}
				}
				return false
			}

			if !contains(Query{Scope: ScopeAll}) {
				t.Fatalf("List(all) does not contain %s at all", label)
			}
			hidden := !contains(Query{Scope: ScopeAll, HideSystem: true})
			if hidden != tc.wantSystem {
				t.Errorf("List(all, hiding system resources) hides %s: %t, want %t", label, hidden, tc.wantSystem)
			}
		})
	}
}

func TestListDoesNotGuessBootstrapWithoutKnowingWhenTheClusterStarted(t *testing.T) {
	s := New()
	add(t, s, `{apiVersion: storage.k8s.io/v1, kind: StorageClass, metadata: {name: standard, creationTimestamp: "`+duringSetup+`"}}`)

	got := names(s.List(Query{Scope: ScopeAll, HideSystem: true}))
	if diff := cmp.Diff([]string{"StorageClass/standard"}, got); diff != "" {
		t.Errorf("List(all, hiding system resources) without a kube-system namespace diff (-want +got):\n%s", diff)
	}
}

// freshCluster is a cluster right after creation plus one application its
// user deployed ten minutes later.
func freshCluster(t *testing.T) *Store {
	t.Helper()
	s := New()
	for _, k := range []Kind{
		{Version: "v1", Kind: "Namespace"},
		{Version: "v1", Kind: "Node"},
		{Version: "v1", Kind: "Pod", Namespaced: true},
		{Version: "v1", Kind: "ConfigMap", Namespaced: true},
		{Group: "apps", Version: "v1", Kind: "DaemonSet", Namespaced: true},
		{Group: "apps", Version: "v1", Kind: "Deployment", Namespaced: true},
		{Group: "storage.k8s.io", Version: "v1", Kind: "StorageClass"},
	} {
		s.AddKind(k)
	}
	add(t, s, kubeSystemNamespace,
		`{apiVersion: v1, kind: Namespace, metadata: {name: default, creationTimestamp: "`+atBootstrap+`"}, status: {phase: Active}}`,
		`{apiVersion: v1, kind: Node, metadata: {name: worker-1, creationTimestamp: "`+atBootstrap+`"}, status: {conditions: [{type: Ready, status: "True"}]}}`,
		`{apiVersion: storage.k8s.io/v1, kind: StorageClass, metadata: {name: standard, creationTimestamp: "`+duringSetup+`"}}`,
		`{apiVersion: v1, kind: ConfigMap, metadata: {namespace: default, name: kube-root-ca.crt, creationTimestamp: "`+atBootstrap+`"}}`,
		`{apiVersion: apps/v1, kind: DaemonSet, metadata: {namespace: kube-system, name: kube-proxy, uid: ds-proxy, creationTimestamp: "`+atBootstrap+`"}, status: {desiredNumberScheduled: 1, numberReady: 1, updatedNumberScheduled: 1}}`,
		fmt.Sprintf(`
apiVersion: v1
kind: Pod
metadata:
  namespace: kube-system
  name: kube-proxy-x
  creationTimestamp: %q
  ownerReferences:
  - {apiVersion: apps/v1, kind: DaemonSet, name: kube-proxy, uid: ds-proxy, controller: true}
spec: {nodeName: worker-1}
status: {phase: Failed}
`, later),
		`{apiVersion: apps/v1, kind: Deployment, metadata: {namespace: default, name: web, creationTimestamp: "`+later+`"}, spec: {replicas: 0}}`,
		fmt.Sprintf(`
apiVersion: v1
kind: Pod
metadata: {namespace: default, name: web-1, creationTimestamp: %q}
spec: {nodeName: worker-1}
status: {phase: Running, conditions: [{type: Ready, status: "True"}]}
`, later),
	)
	return s
}

func TestListScopesHideSystemResources(t *testing.T) {
	tests := []struct {
		name  string
		query Query
		want  []string
	}{
		{
			name:  "user_namespace_keeps_user_resources",
			query: Query{Scope: ScopeNamespace, Target: "default", HideSystem: true},
			want:  []string{"Deployment/web", "Pod/web-1"},
		},
		{
			name:  "system_namespace_lists_nothing",
			query: Query{Scope: ScopeNamespace, Target: "kube-system", HideSystem: true},
		},
		{
			name:  "cluster_wide_area",
			query: Query{Scope: ScopeCluster, HideSystem: true},
		},
		{
			name:  "nodes_are_always_listed",
			query: Query{Scope: ScopeNodes, HideSystem: true},
			want:  []string{"Node/worker-1"},
		},
		{
			name:  "pods_on_a_node",
			query: Query{Scope: ScopePodsOnNode, Target: "worker-1", HideSystem: true},
			want:  []string{"Pod/web-1"},
		},
		{
			name:  "children_of_a_system_resource",
			query: Query{Scope: ScopeChildren, Target: "ds-proxy", HideSystem: true},
		},
		{
			name:  "everything",
			query: Query{Scope: ScopeAll, HideSystem: true},
			want:  []string{"Namespace/default", "Node/worker-1", "Deployment/web", "Pod/web-1"},
		},
		{
			name:  "system_resources_shown_when_asked_for",
			query: Query{Scope: ScopeNamespace, Target: "kube-system"},
			want:  []string{"DaemonSet/kube-proxy"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := freshCluster(t).List(tc.query)
			if diff := cmp.Diff(tc.want, names(got)); diff != "" {
				t.Errorf("List(%+v) diff (-want +got):\n%s", tc.query, diff)
			}
			if got.Total != len(tc.want) {
				t.Errorf("List(%+v).Total = %d, want %d", tc.query, got.Total, len(tc.want))
			}
		})
	}
}

func TestOverviewFollowsTheSystemResourcesSwitch(t *testing.T) {
	s := freshCluster(t)

	hidden := s.Overview(OverviewOptions{HideSystem: true})
	shown := s.Overview(OverviewOptions{})

	// Switched off: only the node, the default namespace, and the user's
	// application count, and the failing system pod does not.
	wantHidden := Overview{
		Sync:            Sync{KindsTotal: 7, Errors: []KindError{}},
		Health:          Rollup{Green: 4},
		SystemResources: 5,
		Kinds: []KindSummary{
			{KindID: "core/Namespace", Group: "core", Version: "v1", Kind: "Namespace", Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "core/Node", Group: "core", Version: "v1", Kind: "Node", Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "apps/Deployment", Group: "apps", Version: "v1", Kind: "Deployment", Namespaced: true, Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "apps/DaemonSet", Group: "apps", Version: "v1", Kind: "DaemonSet", Namespaced: true},
			{KindID: "core/Pod", Group: "core", Version: "v1", Kind: "Pod", Namespaced: true, Count: 1, Rollup: Rollup{Green: 1}},
			{KindID: "core/ConfigMap", Group: "core", Version: "v1", Kind: "ConfigMap", Namespaced: true},
			{KindID: "storage.k8s.io/StorageClass", Group: "storage.k8s.io", Version: "v1", Kind: "StorageClass"},
		},
		Namespaces: []NamespaceSummary{
			{Name: "default", UID: "namespace-default", Health: "green", Reason: "Active", Count: 2, Rollup: Rollup{Green: 2}},
		},
		Nodes: Area{Count: 1, Rollup: Rollup{Green: 1}},
	}
	ignoreRevision := cmpopts.IgnoreFields(Overview{}, "Revision")
	if diff := cmp.Diff(wantHidden, hidden, ignoreRevision); diff != "" {
		t.Errorf("Overview(hiding system resources) diff (-want +got):\n%s", diff)
	}

	// Switched on: everything counts, including the failing system pod.
	if want := (Rollup{Green: 8, Red: 1}); shown.Health != want {
		t.Errorf("Overview(showing system resources).Health = %+v, want %+v", shown.Health, want)
	}
	var namespaces []string
	for _, ns := range shown.Namespaces {
		namespaces = append(namespaces, ns.Name)
	}
	if diff := cmp.Diff([]string{"default", "kube-system"}, namespaces); diff != "" {
		t.Errorf("Overview(showing system resources) namespaces diff (-want +got):\n%s", diff)
	}
	if want := (Area{Count: 1, Rollup: Rollup{Green: 1}}); shown.ClusterScoped != want {
		t.Errorf("Overview(showing system resources).ClusterScoped = %+v, want %+v", shown.ClusterScoped, want)
	}
	if shown.SystemResources != 5 {
		t.Errorf("Overview(showing system resources).SystemResources = %d, want 5 whatever the switch says", shown.SystemResources)
	}
}

func TestDetailOfSystemResourceIsAlwaysAvailable(t *testing.T) {
	s := freshCluster(t)
	if _, ok := s.Detail("configmap-kube-root-ca.crt"); !ok {
		t.Errorf("Detail(%q) not found; system resources must stay reachable through references", "configmap-kube-root-ca.crt")
	}
}
