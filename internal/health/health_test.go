package health

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"sigs.k8s.io/yaml"
)

// object parses a YAML manifest into the generic form Evaluate consumes.
func object(t *testing.T, manifest string) map[string]any {
	t.Helper()
	var obj map[string]any
	if err := yaml.Unmarshal([]byte(manifest), &obj); err != nil {
		t.Fatalf("parsing test manifest: %v\n%s", err, manifest)
	}
	return obj
}

func TestEvaluatePod(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     Status
	}{
		{
			name: "running_all_containers_ready",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Running
  conditions:
  - {type: Ready, status: "True"}
  containerStatuses:
  - {name: app, ready: true, state: {running: {}}}
`,
			want: Green,
		},
		{
			name: "completed_successfully",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Succeeded
  containerStatuses:
  - {name: app, ready: false, state: {terminated: {exitCode: 0, reason: Completed}}}
`,
			want: Green,
		},
		{
			name: "waiting_to_be_scheduled",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Pending
  conditions:
  - {type: PodScheduled, status: "False", reason: Unschedulable}
`,
			want: Yellow,
		},
		{
			name: "creating_containers",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Pending
  containerStatuses:
  - {name: app, ready: false, state: {waiting: {reason: ContainerCreating}}}
`,
			want: Yellow,
		},
		{
			name: "running_container_not_ready",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Running
  conditions:
  - {type: Ready, status: "False", reason: ContainersNotReady}
  containerStatuses:
  - {name: app, ready: false, state: {running: {}}}
`,
			want: Yellow,
		},
		{
			name: "being_deleted",
			manifest: `
apiVersion: v1
kind: Pod
metadata:
  deletionTimestamp: "2026-11-14T17:00:00Z"
status:
  phase: Running
  conditions:
  - {type: Ready, status: "True"}
`,
			want: Yellow,
		},
		{
			name: "crash_looping",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Running
  conditions:
  - {type: Ready, status: "False", reason: ContainersNotReady}
  containerStatuses:
  - {name: app, ready: false, restartCount: 7, state: {waiting: {reason: CrashLoopBackOff}}}
`,
			want: Red,
		},
		{
			name: "cannot_pull_image",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Pending
  containerStatuses:
  - {name: app, ready: false, state: {waiting: {reason: ImagePullBackOff}}}
`,
			want: Red,
		},
		{
			name: "init_container_cannot_pull_image",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Pending
  initContainerStatuses:
  - {name: setup, ready: false, state: {waiting: {reason: ErrImagePull}}}
`,
			want: Red,
		},
		{
			name: "failed",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Failed
  reason: Evicted
`,
			want: Red,
		},
		{
			name: "no_status_yet",
			manifest: `
apiVersion: v1
kind: Pod
`,
			want: Yellow,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(object(t, tc.manifest))
			if got.Status != tc.want {
				t.Errorf("Evaluate(%s) = %q (%s), want %q", tc.name, got.Status, got.Reason, tc.want)
			}
		})
	}
}

func TestEvaluateWorkload(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     Status
	}{
		{
			name: "deployment_all_replicas_available",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 2}
spec: {replicas: 3}
status:
  observedGeneration: 2
  replicas: 3
  updatedReplicas: 3
  readyReplicas: 3
  availableReplicas: 3
  conditions:
  - {type: Available, status: "True", reason: MinimumReplicasAvailable}
  - {type: Progressing, status: "True", reason: NewReplicaSetAvailable}
`,
			want: Green,
		},
		{
			name: "deployment_scaled_to_zero",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 1}
spec: {replicas: 0}
status: {observedGeneration: 1}
`,
			want: Green,
		},
		{
			name: "deployment_default_replica_count_not_yet_available",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 1}
spec: {}
status: {observedGeneration: 1}
`,
			want: Yellow,
		},
		{
			name: "deployment_rolling_out",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 2}
spec: {replicas: 3}
status:
  observedGeneration: 2
  replicas: 4
  updatedReplicas: 2
  readyReplicas: 3
  availableReplicas: 3
  conditions:
  - {type: Progressing, status: "True", reason: ReplicaSetUpdated}
`,
			want: Yellow,
		},
		{
			name: "deployment_old_replicas_still_terminating",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 2}
spec: {replicas: 3}
status:
  observedGeneration: 2
  replicas: 4
  updatedReplicas: 3
  readyReplicas: 4
  availableReplicas: 4
`,
			want: Yellow,
		},
		{
			name: "deployment_not_observed",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 3}
spec: {replicas: 3}
status:
  observedGeneration: 2
  replicas: 3
  updatedReplicas: 3
  readyReplicas: 3
  availableReplicas: 3
`,
			want: Yellow,
		},
		{
			name: "deployment_progress_deadline_exceeded",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 2}
spec: {replicas: 3}
status:
  observedGeneration: 2
  replicas: 3
  updatedReplicas: 1
  conditions:
  - {type: Progressing, status: "False", reason: ProgressDeadlineExceeded}
`,
			want: Red,
		},
		{
			name: "deployment_cannot_create_replicas",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 1}
spec: {replicas: 1}
status:
  observedGeneration: 1
  conditions:
  - {type: ReplicaFailure, status: "True", reason: FailedCreate}
`,
			want: Red,
		},
		{
			name: "replicaset_all_ready",
			manifest: `
apiVersion: apps/v1
kind: ReplicaSet
metadata: {generation: 1}
spec: {replicas: 2}
status: {observedGeneration: 1, replicas: 2, readyReplicas: 2}
`,
			want: Green,
		},
		{
			name: "replicaset_scaled_down_by_rollout",
			manifest: `
apiVersion: apps/v1
kind: ReplicaSet
metadata: {generation: 2}
spec: {replicas: 0}
status: {observedGeneration: 2, replicas: 0}
`,
			want: Green,
		},
		{
			name: "replicaset_waiting_for_pods",
			manifest: `
apiVersion: apps/v1
kind: ReplicaSet
metadata: {generation: 1}
spec: {replicas: 2}
status: {observedGeneration: 1, replicas: 2, readyReplicas: 1}
`,
			want: Yellow,
		},
		{
			name: "statefulset_all_ready",
			manifest: `
apiVersion: apps/v1
kind: StatefulSet
metadata: {generation: 1}
spec: {replicas: 2}
status: {observedGeneration: 1, replicas: 2, readyReplicas: 2, updatedReplicas: 2}
`,
			want: Green,
		},
		{
			name: "statefulset_waiting_for_replicas",
			manifest: `
apiVersion: apps/v1
kind: StatefulSet
metadata: {generation: 1}
spec: {replicas: 3}
status: {observedGeneration: 1, replicas: 2, readyReplicas: 1}
`,
			want: Yellow,
		},
		{
			name: "daemonset_ready_on_every_node",
			manifest: `
apiVersion: apps/v1
kind: DaemonSet
metadata: {generation: 1}
status: {observedGeneration: 1, desiredNumberScheduled: 3, numberReady: 3, updatedNumberScheduled: 3}
`,
			want: Green,
		},
		{
			name: "daemonset_missing_ready_pods",
			manifest: `
apiVersion: apps/v1
kind: DaemonSet
metadata: {generation: 1}
status: {observedGeneration: 1, desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 3}
`,
			want: Yellow,
		},
		{
			name: "job_completed",
			manifest: `
apiVersion: batch/v1
kind: Job
status:
  succeeded: 1
  conditions:
  - {type: Complete, status: "True"}
`,
			want: Green,
		},
		{
			name: "job_running",
			manifest: `
apiVersion: batch/v1
kind: Job
status: {active: 1}
`,
			want: Yellow,
		},
		{
			name: "job_failed",
			manifest: `
apiVersion: batch/v1
kind: Job
status:
  failed: 4
  conditions:
  - {type: Failed, status: "True", reason: BackoffLimitExceeded}
`,
			want: Red,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(object(t, tc.manifest))
			if got.Status != tc.want {
				t.Errorf("Evaluate(%s) = %q (%s), want %q", tc.name, got.Status, got.Reason, tc.want)
			}
		})
	}
}

func TestEvaluateInfrastructure(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     Status
	}{
		{
			name: "node_ready",
			manifest: `
apiVersion: v1
kind: Node
status:
  conditions:
  - {type: MemoryPressure, status: "False", reason: KubeletHasSufficientMemory}
  - {type: DiskPressure, status: "False", reason: KubeletHasNoDiskPressure}
  - {type: PIDPressure, status: "False", reason: KubeletHasSufficientPID}
  - {type: Ready, status: "True", reason: KubeletReady}
`,
			want: Green,
		},
		{
			name: "node_under_memory_pressure",
			manifest: `
apiVersion: v1
kind: Node
status:
  conditions:
  - {type: MemoryPressure, status: "True", reason: KubeletHasInsufficientMemory}
  - {type: Ready, status: "True", reason: KubeletReady}
`,
			want: Yellow,
		},
		{
			name: "node_not_ready",
			manifest: `
apiVersion: v1
kind: Node
status:
  conditions:
  - {type: Ready, status: "False", reason: KubeletNotReady}
`,
			want: Red,
		},
		{
			name: "node_stopped_reporting",
			manifest: `
apiVersion: v1
kind: Node
status:
  conditions:
  - {type: Ready, status: Unknown, reason: NodeStatusUnknown}
`,
			want: Red,
		},
		{
			name: "node_network_unavailable",
			manifest: `
apiVersion: v1
kind: Node
status:
  conditions:
  - {type: NetworkUnavailable, status: "True", reason: NoRouteCreated}
  - {type: Ready, status: "True", reason: KubeletReady}
`,
			want: Red,
		},
		{
			name:     "pvc_bound",
			manifest: "apiVersion: v1\nkind: PersistentVolumeClaim\nstatus: {phase: Bound}\n",
			want:     Green,
		},
		{
			name:     "pvc_waiting_for_volume",
			manifest: "apiVersion: v1\nkind: PersistentVolumeClaim\nstatus: {phase: Pending}\n",
			want:     Yellow,
		},
		{
			name:     "pvc_lost",
			manifest: "apiVersion: v1\nkind: PersistentVolumeClaim\nstatus: {phase: Lost}\n",
			want:     Red,
		},
		{
			name:     "pv_bound",
			manifest: "apiVersion: v1\nkind: PersistentVolume\nstatus: {phase: Bound}\n",
			want:     Green,
		},
		{
			name:     "pv_released",
			manifest: "apiVersion: v1\nkind: PersistentVolume\nstatus: {phase: Released}\n",
			want:     Yellow,
		},
		{
			name:     "pv_failed",
			manifest: "apiVersion: v1\nkind: PersistentVolume\nstatus: {phase: Failed}\n",
			want:     Red,
		},
		{
			name:     "namespace_active",
			manifest: "apiVersion: v1\nkind: Namespace\nstatus: {phase: Active}\n",
			want:     Green,
		},
		{
			name:     "namespace_terminating",
			manifest: "apiVersion: v1\nkind: Namespace\nstatus: {phase: Terminating}\n",
			want:     Yellow,
		},
		{
			name:     "cluster_ip_service",
			manifest: "apiVersion: v1\nkind: Service\nspec: {type: ClusterIP}\nstatus: {loadBalancer: {}}\n",
			want:     Green,
		},
		{
			name:     "load_balancer_service_waiting_for_address",
			manifest: "apiVersion: v1\nkind: Service\nspec: {type: LoadBalancer}\nstatus: {loadBalancer: {}}\n",
			want:     Yellow,
		},
		{
			name: "load_balancer_service_with_address",
			manifest: `
apiVersion: v1
kind: Service
spec: {type: LoadBalancer}
status:
  loadBalancer:
    ingress:
    - {ip: 203.0.113.10}
`,
			want: Green,
		},
		{
			name:     "config_map_has_no_status",
			manifest: "apiVersion: v1\nkind: ConfigMap\ndata: {key: value}\n",
			want:     Green,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(object(t, tc.manifest))
			if got.Status != tc.want {
				t.Errorf("Evaluate(%s) = %q (%s), want %q", tc.name, got.Status, got.Reason, tc.want)
			}
		})
	}
}

func TestEvaluateCustomResource(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     Status
	}{
		{
			name: "ready",
			manifest: `
apiVersion: example.io/v1
kind: Widget
metadata: {generation: 1}
status:
  observedGeneration: 1
  conditions:
  - {type: Ready, status: "True", reason: Reconciled}
`,
			want: Green,
		},
		{
			name: "no_status_at_all",
			manifest: `
apiVersion: example.io/v1
kind: Widget
spec: {size: 3}
`,
			want: Green,
		},
		{
			name: "still_reconciling",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Reconciling, status: "True", reason: Applying}
`,
			want: Yellow,
		},
		{
			name: "latest_change_not_observed",
			manifest: `
apiVersion: example.io/v1
kind: Widget
metadata: {generation: 4}
status:
  observedGeneration: 3
  conditions:
  - {type: Ready, status: "True", reason: Reconciled}
`,
			want: Yellow,
		},
		{
			name: "unknown_outcome",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Ready, status: Unknown, reason: Checking}
`,
			want: Yellow,
		},
		{
			name: "stalled",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Stalled, status: "True", reason: WaitingForInput}
`,
			want: Yellow,
		},
		{
			name: "not_ready_because_of_error",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Ready, status: "False", reason: InvalidSpec}
`,
			want: Red,
		},
		{
			name: "not_ready_because_in_progress",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Ready, status: "False", reason: Provisioning}
`,
			want: Yellow,
		},
		{
			name: "explicit_failure_condition",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Ready, status: "True"}
  - {type: Degraded, status: "True", reason: BackendDown}
`,
			want: Red,
		},
		{
			name: "failure_condition_that_is_false_is_fine",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Ready, status: "True"}
  - {type: Degraded, status: "False"}
  - {type: Stalled, status: "False"}
  - {type: Reconciling, status: "False"}
`,
			want: Green,
		},
		{
			name: "informational_condition_is_ignored",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: ScalingLimited, status: "False", reason: DesiredWithinRange}
`,
			want: Green,
		},
		{
			name: "red_outranks_yellow",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Reconciling, status: "True"}
  - {type: Ready, status: "False", reason: InvalidSpec}
`,
			want: Red,
		},
		{
			name: "being_deleted",
			manifest: `
apiVersion: example.io/v1
kind: Widget
metadata: {deletionTimestamp: "2026-11-14T17:00:00Z"}
status:
  conditions:
  - {type: Ready, status: "False", reason: InvalidSpec}
`,
			want: Yellow,
		},
		{
			name: "established_custom_resource_definition",
			manifest: `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
status:
  conditions:
  - {type: NamesAccepted, status: "True", reason: NoConflicts}
  - {type: Established, status: "True", reason: InitialNamesAccepted}
`,
			want: Green,
		},
		{
			name: "custom_resource_definition_with_name_conflict",
			manifest: `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
status:
  conditions:
  - {type: NamesAccepted, status: "False", reason: PluralConflict}
`,
			want: Red,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(object(t, tc.manifest))
			if got.Status != tc.want {
				t.Errorf("Evaluate(%s) = %q (%s), want %q", tc.name, got.Status, got.Reason, tc.want)
			}
		})
	}
}

func TestEvaluateGatewayAPI(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     Status
	}{
		{
			name: "gateway_accepted_and_programmed",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {generation: 1}
status:
  conditions:
  - {type: Accepted, status: "True", reason: Accepted, observedGeneration: 1}
  - {type: Programmed, status: "True", reason: Programmed, observedGeneration: 1}
  listeners:
  - name: http
    conditions:
    - {type: Accepted, status: "True", reason: Accepted}
    - {type: ResolvedRefs, status: "True", reason: ResolvedRefs}
`,
			want: Green,
		},
		{
			name: "gateway_waiting_for_controller",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
status:
  conditions:
  - {type: Accepted, status: Unknown, reason: Pending, message: Waiting for controller}
  - {type: Programmed, status: Unknown, reason: Pending, message: Waiting for controller}
`,
			want: Yellow,
		},
		{
			name: "gateway_listener_with_unresolved_references",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
status:
  conditions:
  - {type: Accepted, status: "True", reason: Accepted}
  - {type: Programmed, status: "True", reason: Programmed}
  listeners:
  - name: https
    conditions:
    - {type: ResolvedRefs, status: "False", reason: InvalidCertificateRef}
`,
			want: Red,
		},
		{
			name: "route_accepted_by_every_parent",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
  - {name: web}
status:
  parents:
  - parentRef: {name: web}
    conditions:
    - {type: Accepted, status: "True", reason: Accepted}
    - {type: ResolvedRefs, status: "True", reason: ResolvedRefs}
`,
			want: Green,
		},
		{
			name: "route_not_picked_up_by_any_gateway",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
  - {name: web}
status:
  parents: []
`,
			want: Yellow,
		},
		{
			name: "route_without_status",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
spec:
  parentRefs:
  - {name: web}
`,
			want: Yellow,
		},
		{
			name: "route_rejected_by_parent",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
  - {name: web}
status:
  parents:
  - parentRef: {name: web}
    conditions:
    - {type: Accepted, status: "False", reason: NotAllowedByListeners}
`,
			want: Red,
		},
		{
			name: "gateway_class_waiting_for_controller",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
status:
  conditions:
  - {type: Accepted, status: Unknown, reason: Pending}
`,
			want: Yellow,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(object(t, tc.manifest))
			if got.Status != tc.want {
				t.Errorf("Evaluate(%s) = %q (%s), want %q", tc.name, got.Status, got.Reason, tc.want)
			}
		})
	}
}

func TestEvaluateReason(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     Result
	}{
		{
			name: "crash_looping_pod_names_the_container_problem",
			manifest: `
apiVersion: v1
kind: Pod
status:
  phase: Running
  containerStatuses:
  - {name: app, ready: false, state: {waiting: {reason: CrashLoopBackOff}}}
`,
			want: Result{Status: Red, Reason: "container app: CrashLoopBackOff"},
		},
		{
			name: "deployment_reports_availability",
			manifest: `
apiVersion: apps/v1
kind: Deployment
metadata: {generation: 1}
spec: {replicas: 3}
status: {observedGeneration: 1, replicas: 3, updatedReplicas: 3, availableReplicas: 2}
`,
			want: Result{Status: Yellow, Reason: "2/3 replicas available"},
		},
		{
			name: "condition_names_type_and_reason",
			manifest: `
apiVersion: example.io/v1
kind: Widget
status:
  conditions:
  - {type: Ready, status: "False", reason: InvalidSpec}
`,
			want: Result{Status: Red, Reason: "Ready is False: InvalidSpec"},
		},
		{
			name: "nested_condition_names_its_origin",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
  - {name: web}
status:
  parents:
  - parentRef: {name: web}
    conditions:
    - {type: Accepted, status: "False", reason: NotAllowedByListeners}
`,
			want: Result{Status: Red, Reason: "parents[0]: Accepted is False: NotAllowedByListeners"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(object(t, tc.manifest))
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("Evaluate(%s) diff (-want +got):\n%s", tc.name, diff)
			}
		})
	}
}

func TestContainers(t *testing.T) {
	pod := object(t, `
apiVersion: v1
kind: Pod
spec:
  initContainers:
  - {name: setup, image: busybox:1.36}
  containers:
  - {name: app, image: "nginx:1.27"}
  - {name: sidecar, image: "envoy:1.30"}
  - {name: worker, image: "worker:2"}
  - {name: flaky, image: "flaky:1"}
  - {name: broken, image: "broken:1"}
  - {name: pending, image: "pending:1"}
status:
  initContainerStatuses:
  - {name: setup, ready: true, restartCount: 0, state: {terminated: {exitCode: 0, reason: Completed}}}
  containerStatuses:
  - {name: app, ready: true, restartCount: 0, state: {running: {startedAt: "2026-11-14T17:00:00Z"}}}
  - {name: sidecar, ready: false, restartCount: 0, state: {running: {startedAt: "2026-11-14T17:00:00Z"}}}
  - {name: worker, ready: false, restartCount: 0, state: {waiting: {reason: ContainerCreating}}}
  - {name: flaky, ready: false, restartCount: 12, state: {waiting: {reason: CrashLoopBackOff}}}
  - {name: broken, ready: false, restartCount: 0, state: {terminated: {exitCode: 137, reason: OOMKilled}}}
`)
	want := []Container{
		{Name: "setup", Image: "busybox:1.36", Init: true, Status: Green, State: "terminated", Reason: "Completed", Ready: true},
		{Name: "app", Image: "nginx:1.27", Status: Green, State: "running", Ready: true},
		{Name: "sidecar", Image: "envoy:1.30", Status: Yellow, State: "running", Reason: "not ready"},
		{Name: "worker", Image: "worker:2", Status: Yellow, State: "waiting", Reason: "ContainerCreating"},
		{Name: "flaky", Image: "flaky:1", Status: Red, State: "waiting", Reason: "CrashLoopBackOff", Restarts: 12},
		{Name: "broken", Image: "broken:1", Status: Red, State: "terminated", Reason: "OOMKilled"},
		{Name: "pending", Image: "pending:1", Status: Yellow, State: "unknown", Reason: "no status reported yet"},
	}
	got := Containers(pod)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Containers(pod) diff (-want +got):\n%s", diff)
	}
}

func TestConditionsNewestFirstWithOrigin(t *testing.T) {
	route := object(t, `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
status:
  conditions:
  - {type: Summary, status: "True", reason: Ok, message: fine, lastTransitionTime: "2026-11-14T10:00:00Z"}
  parents:
  - parentRef: {name: web}
    conditions:
    - {type: Accepted, status: "True", reason: Accepted, lastTransitionTime: "2026-11-14T12:00:00Z"}
    - {type: ResolvedRefs, status: "False", reason: BackendNotFound, message: no such service, lastTransitionTime: "2026-11-14T11:00:00Z"}
  - parentRef: {name: other}
    conditions:
    - {type: Accepted, status: "False", reason: NotAllowedByListeners}
`)
	want := []Condition{
		{Type: "Accepted", Status: "True", Reason: "Accepted", LastTransitionTime: "2026-11-14T12:00:00Z", Source: "parents[0]"},
		{Type: "ResolvedRefs", Status: "False", Reason: "BackendNotFound", Message: "no such service", LastTransitionTime: "2026-11-14T11:00:00Z", Source: "parents[0]"},
		{Type: "Summary", Status: "True", Reason: "Ok", Message: "fine", LastTransitionTime: "2026-11-14T10:00:00Z"},
		{Type: "Accepted", Status: "False", Reason: "NotAllowedByListeners", Source: "parents[1]"},
	}
	got := Conditions(route)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Conditions(route) diff (-want +got):\n%s", diff)
	}
}
