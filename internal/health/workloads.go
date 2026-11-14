package health

import "fmt"

// Container describes one container of a Pod and its current state.
type Container struct {
	Name  string
	Image string
	// Init reports whether this is an init container.
	Init   bool
	Status Status
	// State is "running", "waiting", "terminated", or "unknown".
	State    string
	Reason   string
	Ready    bool
	Restarts int64
}

// failedWaitingReasons are the reasons a container is waiting that will not
// resolve without intervention.
var failedWaitingReasons = map[string]bool{
	"CrashLoopBackOff":           true,
	"ImagePullBackOff":           true,
	"ErrImagePull":               true,
	"ErrImageNeverPull":          true,
	"InvalidImageName":           true,
	"CreateContainerConfigError": true,
	"CreateContainerError":       true,
	"RunContainerError":          true,
	"PreCreateHookError":         true,
	"PreStartHookError":          true,
	"PostStartHookError":         true,
}

// Containers returns the containers of pod, init containers first, each with
// its own health.
func Containers(pod map[string]any) []Container {
	var containers []Container
	containers = appendContainers(containers, pod, "initContainers", "initContainerStatuses", true)
	containers = appendContainers(containers, pod, "containers", "containerStatuses", false)
	return containers
}

func appendContainers(containers []Container, pod map[string]any, specField, statusField string, init bool) []Container {
	statuses := make(map[string]map[string]any)
	for _, raw := range list(pod, "status", statusField) {
		s := dict(raw)
		statuses[str(s, "name")] = s
	}
	for _, raw := range list(pod, "spec", specField) {
		spec := dict(raw)
		c := Container{Name: str(spec, "name"), Image: str(spec, "image"), Init: init}
		containers = append(containers, withState(c, statuses[c.Name]))
	}
	return containers
}

// reportedContainers returns the containers the kubelet has reported a status
// for, whether or not they are declared in the pod's spec. Pod health is
// derived from these so that it reflects what is actually running.
func reportedContainers(pod map[string]any) []Container {
	var containers []Container
	for _, statusField := range []string{"initContainerStatuses", "containerStatuses"} {
		for _, raw := range list(pod, "status", statusField) {
			status := dict(raw)
			c := Container{Name: str(status, "name"), Init: statusField == "initContainerStatuses"}
			containers = append(containers, withState(c, status))
		}
	}
	return containers
}

// withState fills in the fields of c that come from its reported status.
func withState(c Container, status map[string]any) Container {
	if status == nil {
		c.Status, c.State, c.Reason = Yellow, "unknown", "no status reported yet"
		return c
	}
	c.Ready, _ = status["ready"].(bool)
	c.Restarts = count(status, "restartCount")
	state := dict(status["state"])
	switch {
	case state["running"] != nil:
		c.State = "running"
		switch {
		case c.Ready:
			c.Status = Green
		case c.Init:
			c.Status, c.Reason = Yellow, "initializing"
		default:
			c.Status, c.Reason = Yellow, "not ready"
		}
	case state["terminated"] != nil:
		c.State = "terminated"
		terminated := dict(state["terminated"])
		exitCode := count(terminated, "exitCode")
		c.Reason = str(terminated, "reason")
		if c.Reason == "" {
			c.Reason = fmt.Sprintf("exit code %d", exitCode)
		}
		c.Status = Green
		if exitCode != 0 {
			c.Status = Red
		}
	case state["waiting"] != nil:
		c.State = "waiting"
		c.Reason = str(dict(state["waiting"]), "reason")
		c.Status = Yellow
		if failedWaitingReasons[c.Reason] {
			c.Status = Red
		}
	default:
		c.Status, c.State, c.Reason = Yellow, "unknown", "no status reported yet"
	}
	return c
}

func pod(obj map[string]any) Result {
	phase := str(obj, "status", "phase")
	switch phase {
	case "Succeeded":
		return Result{Status: Green, Reason: "Completed"}
	case "Failed":
		return Result{Status: Red, Reason: firstNonEmpty(str(obj, "status", "reason"), "Failed")}
	}
	containers := reportedContainers(obj)
	for _, c := range containers {
		if c.Status == Red {
			return Result{Status: Red, Reason: fmt.Sprintf("container %s: %s", c.Name, c.Reason)}
		}
	}
	switch phase {
	case "Running":
		ready, ok := condition(obj, "Ready")
		if ok && ready.Status == "True" {
			return Result{Status: Green, Reason: "Running"}
		}
		return Result{Status: Yellow, Reason: firstNonEmpty(ready.Reason, "not ready")}
	case "Pending":
		if scheduled, ok := condition(obj, "PodScheduled"); ok && scheduled.Status == "False" {
			return Result{Status: Yellow, Reason: firstNonEmpty(scheduled.Reason, "not scheduled")}
		}
		for _, c := range containers {
			if c.State == "waiting" && c.Reason != "" {
				return Result{Status: Yellow, Reason: c.Reason}
			}
		}
		return Result{Status: Yellow, Reason: "Pending"}
	}
	return Result{Status: Yellow, Reason: firstNonEmpty(phase, "no status reported yet")}
}

func deployment(obj map[string]any) Result {
	if stale(obj) {
		return staleResult()
	}
	if c, ok := condition(obj, "Progressing"); ok && c.Status == "False" {
		return Result{Status: Red, Reason: describe(c)}
	}
	if c, ok := condition(obj, "ReplicaFailure"); ok && c.Status == "True" {
		return Result{Status: Red, Reason: describe(c)}
	}
	desired := desiredReplicas(obj)
	updated := count(obj, "status", "updatedReplicas")
	total := count(obj, "status", "replicas")
	available := count(obj, "status", "availableReplicas")
	switch {
	case updated < desired:
		return Result{Status: Yellow, Reason: fmt.Sprintf("%d/%d replicas updated", updated, desired)}
	case total > updated:
		return Result{Status: Yellow, Reason: fmt.Sprintf("%d old replicas pending termination", total-updated)}
	case available < desired:
		return Result{Status: Yellow, Reason: fmt.Sprintf("%d/%d replicas available", available, desired)}
	}
	return Result{Status: Green, Reason: fmt.Sprintf("%d/%d replicas available", available, desired)}
}

// replicaSet also covers ReplicationControllers, which report the same
// fields.
func replicaSet(obj map[string]any) Result {
	if stale(obj) {
		return staleResult()
	}
	if c, ok := condition(obj, "ReplicaFailure"); ok && c.Status == "True" {
		return Result{Status: Red, Reason: describe(c)}
	}
	return readyOf(count(obj, "status", "readyReplicas"), desiredReplicas(obj), "replicas")
}

func statefulSet(obj map[string]any) Result {
	if stale(obj) {
		return staleResult()
	}
	return readyOf(count(obj, "status", "readyReplicas"), desiredReplicas(obj), "replicas")
}

func daemonSet(obj map[string]any) Result {
	if stale(obj) {
		return staleResult()
	}
	desired := count(obj, "status", "desiredNumberScheduled")
	if updated := count(obj, "status", "updatedNumberScheduled"); updated < desired {
		return Result{Status: Yellow, Reason: fmt.Sprintf("%d/%d pods updated", updated, desired)}
	}
	return readyOf(count(obj, "status", "numberReady"), desired, "pods")
}

func job(obj map[string]any) Result {
	if c, ok := condition(obj, "Failed"); ok && c.Status == "True" {
		return Result{Status: Red, Reason: describe(c)}
	}
	if c, ok := condition(obj, "Complete"); ok && c.Status == "True" {
		return Result{Status: Green, Reason: "Completed"}
	}
	if suspended, _ := field(obj, "spec", "suspend"); suspended == true {
		return Result{Status: Yellow, Reason: "Suspended"}
	}
	return Result{Status: Yellow, Reason: fmt.Sprintf("running (%d active)", count(obj, "status", "active"))}
}

// desiredReplicas returns spec.replicas, which defaults to 1 when unset.
func desiredReplicas(obj map[string]any) int64 {
	if replicas, ok := integer(obj, "spec", "replicas"); ok {
		return replicas
	}
	return 1
}

func readyOf(ready, desired int64, noun string) Result {
	reason := fmt.Sprintf("%d/%d %s ready", ready, desired, noun)
	if ready < desired {
		return Result{Status: Yellow, Reason: reason}
	}
	return Result{Status: Green, Reason: reason}
}
