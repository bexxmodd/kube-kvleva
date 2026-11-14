package graph

import (
	"fmt"
	"runtime"
	"testing"
)

// The benchmarks below model a large cluster: 2,000 nodes and 100,000 pods
// spread over 100 namespaces, each namespace holding 20 deployments with one
// replica set and 50 pods each, plus one service per deployment selecting
// its pods.
const (
	benchNodes       = 2000
	benchNamespaces  = 100
	benchDeployments = 20
	benchPodsPerSet  = 50
)

func benchObject(apiVersion, kind, namespace, name string, extra map[string]any) map[string]any {
	metadata := map[string]any{
		"name":            name,
		"uid":             kind + "/" + namespace + "/" + name,
		"resourceVersion": "1",
		"managedFields":   []any{map[string]any{"manager": "kubelet", "operation": "Update"}},
	}
	if namespace != "" {
		metadata["namespace"] = namespace
	}
	obj := map[string]any{"apiVersion": apiVersion, "kind": kind, "metadata": metadata}
	for key, value := range extra {
		if key == "metadata" {
			for k, v := range value.(map[string]any) {
				metadata[k] = v
			}
			continue
		}
		obj[key] = value
	}
	return obj
}

func owner(apiVersion, kind, namespace, name string) []any {
	return []any{map[string]any{
		"apiVersion": apiVersion, "kind": kind, "name": name,
		"uid": kind + "/" + namespace + "/" + name, "controller": true,
	}}
}

// fillLargeCluster loads the modeled cluster into s and returns the number
// of resources stored.
func fillLargeCluster(tb testing.TB, s *Store) int {
	tb.Helper()
	count := 0
	put := func(kind Kind, obj map[string]any) {
		if err := s.Upsert(kind, obj); err != nil {
			tb.Fatalf("Upsert failed: %v", err)
		}
		count++
	}
	nodeKind := Kind{Version: "v1", Kind: "Node"}
	podKind := Kind{Version: "v1", Kind: "Pod", Namespaced: true}
	serviceKind := Kind{Version: "v1", Kind: "Service", Namespaced: true}
	deploymentKind := Kind{Group: "apps", Version: "v1", Kind: "Deployment", Namespaced: true}
	replicaSetKind := Kind{Group: "apps", Version: "v1", Kind: "ReplicaSet", Namespaced: true}

	for n := range benchNodes {
		put(nodeKind, benchObject("v1", "Node", "", fmt.Sprintf("node-%04d", n), map[string]any{
			"status": map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True"}}},
		}))
	}
	pod := 0
	for ns := range benchNamespaces {
		namespace := fmt.Sprintf("team-%03d", ns)
		for d := range benchDeployments {
			app := fmt.Sprintf("app-%02d", d)
			put(deploymentKind, benchObject("apps/v1", "Deployment", namespace, app, map[string]any{
				"spec": map[string]any{"replicas": int64(benchPodsPerSet)},
				"status": map[string]any{
					"replicas": int64(benchPodsPerSet), "updatedReplicas": int64(benchPodsPerSet),
					"availableReplicas": int64(benchPodsPerSet),
				},
			}))
			put(replicaSetKind, benchObject("apps/v1", "ReplicaSet", namespace, app+"-rs", map[string]any{
				"metadata": map[string]any{"ownerReferences": owner("apps/v1", "Deployment", namespace, app)},
				"spec":     map[string]any{"replicas": int64(benchPodsPerSet)},
				"status":   map[string]any{"readyReplicas": int64(benchPodsPerSet)},
			}))
			put(serviceKind, benchObject("v1", "Service", namespace, app, map[string]any{
				"spec": map[string]any{"selector": map[string]any{"app": app}},
			}))
			for p := range benchPodsPerSet {
				pod++
				put(podKind, benchObject("v1", "Pod", namespace, fmt.Sprintf("%s-rs-%03d", app, p), map[string]any{
					"metadata": map[string]any{
						"labels":          map[string]any{"app": app, "pod-template-hash": "abc123"},
						"ownerReferences": owner("apps/v1", "ReplicaSet", namespace, app+"-rs"),
					},
					"spec": map[string]any{
						"nodeName":           fmt.Sprintf("node-%04d", pod%benchNodes),
						"serviceAccountName": "default",
						"containers": []any{
							map[string]any{"name": "app", "image": "registry.example/app:1.2.3", "envFrom": []any{
								map[string]any{"configMapRef": map[string]any{"name": app + "-config"}},
							}},
							map[string]any{"name": "sidecar", "image": "registry.example/proxy:4.5.6"},
						},
					},
					"status": map[string]any{
						"phase":      "Running",
						"conditions": []any{map[string]any{"type": "Ready", "status": "True"}},
						"containerStatuses": []any{
							map[string]any{"name": "app", "ready": true, "state": map[string]any{"running": map[string]any{}}},
							map[string]any{"name": "sidecar", "ready": true, "state": map[string]any{"running": map[string]any{}}},
						},
					},
				}))
			}
		}
	}
	return count
}

// BenchmarkLargeCluster reports how long the questions of the web interface
// take on the modeled cluster, and how much memory holding it costs.
func BenchmarkLargeCluster(b *testing.B) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	s := New()
	count := fillLargeCluster(b, s)
	runtime.GC()
	runtime.ReadMemStats(&after)
	b.Logf("%d resources held in %.0f MiB (%.0f bytes each)", count,
		float64(after.HeapAlloc-before.HeapAlloc)/(1<<20), float64(after.HeapAlloc-before.HeapAlloc)/float64(count))

	benchmarks := []struct {
		name string
		run  func()
	}{
		{name: "overview", run: func() { s.Overview() }},
		{name: "namespace_page", run: func() { s.List(Query{Scope: ScopeNamespace, Target: "team-042"}) }},
		{name: "namespace_page_failing_only", run: func() {
			s.List(Query{Scope: ScopeNamespace, Target: "team-042", Health: []string{"red"}})
		}},
		{name: "pods_of_replica_set", run: func() {
			s.List(Query{Scope: ScopeChildren, Target: "ReplicaSet/team-042/app-07-rs"})
		}},
		{name: "nodes_page", run: func() { s.List(Query{Scope: ScopeNodes}) }},
		{name: "pods_on_node", run: func() { s.List(Query{Scope: ScopePodsOnNode, Target: "node-0042"}) }},
		{name: "global_search", run: func() { s.List(Query{Scope: ScopeAll, Text: "app-07-rs-01"}) }},
		{name: "pod_detail", run: func() { s.Detail("Pod/team-042/app-07-rs-011") }},
		{name: "node_detail", run: func() { s.Detail("Node//node-0042") }},
	}
	for _, bm := range benchmarks {
		b.Run(bm.name, func(b *testing.B) {
			for b.Loop() {
				bm.run()
			}
		})
	}
}

func BenchmarkUpsert(b *testing.B) {
	s := New()
	podKind := Kind{Version: "v1", Kind: "Pod", Namespaced: true}
	i := 0
	for b.Loop() {
		i++
		obj := benchObject("v1", "Pod", "default", fmt.Sprintf("pod-%d", i%1000), map[string]any{
			"metadata": map[string]any{"resourceVersion": fmt.Sprint(i), "labels": map[string]any{"app": "web"}},
			"spec": map[string]any{"nodeName": "node-1", "containers": []any{
				map[string]any{"name": "app", "image": "registry.example/app:1.2.3"},
			}},
			"status": map[string]any{"phase": "Running"},
		})
		if err := s.Upsert(podKind, obj); err != nil {
			b.Fatalf("Upsert failed: %v", err)
		}
	}
}
