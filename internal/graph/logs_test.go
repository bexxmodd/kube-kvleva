package graph

import (
	"fmt"
	"testing"

	"github.com/google/go-cmp/cmp"
)

const (
	podWebInit = `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: web-7d4b9c-zzzzz
  ownerReferences:
  - {apiVersion: apps/v1, kind: ReplicaSet, name: web-7d4b9c, uid: replicaset-web-7d4b9c, controller: true}
spec:
  initContainers:
  - {name: migrate, image: "migrate:1"}
  containers:
  - {name: app, image: "nginx:1.27"}
status:
  phase: Running
  initContainerStatuses:
  - {name: migrate, ready: true, state: {terminated: {exitCode: 0, reason: Completed}}}
  containerStatuses:
  - {name: app, ready: true, state: {running: {}}}
`
	configMapSettings = `
apiVersion: v1
kind: ConfigMap
metadata: {namespace: default, name: settings}
data: {mode: fast}
`
)

func TestLogTargets(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb, podWeb, podWebInit, configMapSettings)

	abcde := []LogSource{
		{Namespace: "default", Pod: "web-7d4b9c-abcde", Container: "app"},
		{Namespace: "default", Pod: "web-7d4b9c-abcde", Container: "sidecar"},
	}
	zzzzz := []LogSource{
		{Namespace: "default", Pod: "web-7d4b9c-zzzzz", Container: "migrate"},
		{Namespace: "default", Pod: "web-7d4b9c-zzzzz", Container: "app"},
	}
	both := append(append([]LogSource{}, abcde...), zzzzz...)

	tests := []struct {
		name string
		uid  string
		want LogTargets
	}{
		{
			name: "pod_has_every_container_of_its_own",
			uid:  "pod-web-7d4b9c-abcde",
			want: LogTargets{Sources: abcde, Pods: 1, TotalPods: 1},
		},
		{
			name: "pod_lists_init_containers_first",
			uid:  "pod-web-7d4b9c-zzzzz",
			want: LogTargets{Sources: zzzzz, Pods: 1, TotalPods: 1},
		},
		{
			name: "replica_set_has_its_pods_by_name",
			uid:  "replicaset-web-7d4b9c",
			want: LogTargets{Sources: both, Pods: 2, TotalPods: 2},
		},
		{
			name: "deployment_has_the_pods_nested_at_any_depth",
			uid:  "deployment-web",
			want: LogTargets{Sources: both, Pods: 2, TotalPods: 2},
		},
		{
			name: "resource_that_runs_nothing_has_none",
			uid:  "configmap-settings",
			want: LogTargets{},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := s.LogTargets(tc.uid, 10)
			if !ok {
				t.Fatalf("LogTargets(%q, 10) reported an unknown resource", tc.uid)
			}
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("LogTargets(%q, 10) diff (-want +got):\n%s", tc.uid, diff)
			}
		})
	}
}

func TestLogTargetsOfWorkloadWithoutPods(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb)

	got, ok := s.LogTargets("deployment-web", 10)
	if !ok {
		t.Fatalf("LogTargets(%q, 10) reported an unknown resource", "deployment-web")
	}
	if diff := cmp.Diff(LogTargets{}, got); diff != "" {
		t.Errorf("LogTargets(%q, 10) diff (-want +got):\n%s", "deployment-web", diff)
	}
}

func TestLogTargetsLimitsPods(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb)
	for i := range 23 {
		add(t, s, fmt.Sprintf(`
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: web-7d4b9c-%02d
  ownerReferences:
  - {apiVersion: apps/v1, kind: ReplicaSet, name: web-7d4b9c, uid: replicaset-web-7d4b9c, controller: true}
spec:
  containers:
  - {name: app, image: "nginx:1.27"}
`, i))
	}

	got, ok := s.LogTargets("deployment-web", 10)
	if !ok {
		t.Fatalf("LogTargets(%q, 10) reported an unknown resource", "deployment-web")
	}
	if got.Pods != 10 || got.TotalPods != 23 {
		t.Errorf("LogTargets(%q, 10) covers %d of %d pods, want 10 of 23", "deployment-web", got.Pods, got.TotalPods)
	}
	var pods []string
	for _, source := range got.Sources {
		pods = append(pods, source.Pod)
	}
	// The first ten by name, the order in which the pods are listed.
	want := []string{
		"web-7d4b9c-00", "web-7d4b9c-01", "web-7d4b9c-02", "web-7d4b9c-03", "web-7d4b9c-04",
		"web-7d4b9c-05", "web-7d4b9c-06", "web-7d4b9c-07", "web-7d4b9c-08", "web-7d4b9c-09",
	}
	if diff := cmp.Diff(want, pods); diff != "" {
		t.Errorf("LogTargets(%q, 10) pods diff (-want +got):\n%s", "deployment-web", diff)
	}
}

func TestLogTargetsOfUnknownResource(t *testing.T) {
	s := New()
	add(t, s, podWeb)

	if got, ok := s.LogTargets("no-such-uid", 10); ok {
		t.Errorf("LogTargets(%q, 10) = %+v, true; want an unknown resource", "no-such-uid", got)
	}
}

func TestContainerLogTarget(t *testing.T) {
	s := New()
	add(t, s, deploymentWeb, replicaSetWeb, podWeb)

	tests := []struct {
		name      string
		uid       string
		container string
		want      LogTargets
		wantOK    bool
	}{
		{
			name:      "container_of_a_pod",
			uid:       "pod-web-7d4b9c-abcde",
			container: "sidecar",
			want: LogTargets{
				Sources:   []LogSource{{Namespace: "default", Pod: "web-7d4b9c-abcde", Container: "sidecar"}},
				Pods:      1,
				TotalPods: 1,
			},
			wantOK: true,
		},
		{name: "unknown_container", uid: "pod-web-7d4b9c-abcde", container: "nope"},
		{name: "unknown_pod", uid: "no-such-uid", container: "app"},
		{name: "resource_that_is_not_a_pod", uid: "deployment-web", container: "app"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := s.ContainerLogTarget(tc.uid, tc.container)
			if ok != tc.wantOK {
				t.Fatalf("ContainerLogTarget(%q, %q) ok = %t, want %t", tc.uid, tc.container, ok, tc.wantOK)
			}
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("ContainerLogTarget(%q, %q) diff (-want +got):\n%s", tc.uid, tc.container, diff)
			}
		})
	}
}
