// Package health decides whether a Kubernetes resource is reconciled (green),
// still in progress or stuck (yellow), or failed (red).
//
// Resources are inspected in their generic, decoded form (the content of an
// unstructured object), so the same code handles built-in kinds and custom
// resources.
package health

import (
	"fmt"
	"strings"
)

// Status is the traffic-light color of a resource.
type Status string

const (
	// Green means configured and reconciled successfully.
	Green Status = "green"
	// Yellow means still processing, pending, or stuck.
	Yellow Status = "yellow"
	// Red means failed.
	Red Status = "red"
)

// Result is the outcome of evaluating one resource.
type Result struct {
	Status Status
	// Reason is a short human-readable explanation of Status. It may be empty
	// for green resources that report nothing.
	Reason string
}

// Evaluate returns the health of obj, the decoded content of a Kubernetes
// object.
func Evaluate(obj map[string]any) Result {
	if _, deleting := field(obj, "metadata", "deletionTimestamp"); deleting {
		return Result{Status: Yellow, Reason: "Terminating"}
	}
	group, kind := apiGroup(obj), str(obj, "kind")
	switch group {
	case "":
		switch kind {
		case "Pod":
			return pod(obj)
		case "Node":
			return node(obj)
		case "PersistentVolumeClaim":
			return persistentVolumeClaim(obj)
		case "PersistentVolume":
			return persistentVolume(obj)
		case "Namespace":
			return namespace(obj)
		case "Service":
			return service(obj)
		case "ReplicationController":
			return replicaSet(obj)
		}
	case "apps":
		switch kind {
		case "Deployment":
			return deployment(obj)
		case "ReplicaSet":
			return replicaSet(obj)
		case "StatefulSet":
			return statefulSet(obj)
		case "DaemonSet":
			return daemonSet(obj)
		}
	case "batch":
		if kind == "Job" {
			return job(obj)
		}
	}
	return generic(obj)
}

// generic judges a resource purely by the conventions most controllers
// follow: status.observedGeneration and status conditions.
func generic(obj map[string]any) Result {
	if stale(obj) {
		return staleResult()
	}
	if isUnclaimedRoute(obj) {
		return Result{Status: Yellow, Reason: "not accepted by any gateway yet"}
	}
	worst := Result{Status: Green}
	for _, c := range collectConditions(obj) {
		status, relevant := judge(c)
		if relevant && rank(status) > rank(worst.Status) {
			worst = Result{Status: status, Reason: describe(c)}
		}
	}
	return worst
}

// readinessTypes are condition types whose "True" status means the resource
// is in its desired state. Types ending in "Ready" are treated the same way.
var readinessTypes = map[string]bool{
	"Ready":         true,
	"Available":     true,
	"Accepted":      true,
	"Programmed":    true,
	"ResolvedRefs":  true,
	"Established":   true,
	"NamesAccepted": true,
	"Healthy":       true,
	"Synced":        true,
	"Reconciled":    true,
	"Succeeded":     true,
	"Initialized":   true,
	"Deployed":      true,
	"Valid":         true,
	"AbleToScale":   true,
	"ScalingActive": true,
}

// failureSuffixes mark condition types whose "True" status reports a failure,
// for example "Degraded" or "ReplicaFailure".
var failureSuffixes = []string{"Failed", "Failure", "Degraded", "Error"}

// inProgressReasons are fragments of condition reasons that controllers use
// while they are still working towards the desired state.
var inProgressReasons = []string{
	"pending", "progress", "reconcil", "waiting", "creating", "provisioning",
	"initializing", "starting", "updating", "installing", "deploying",
	"scaling", "issuing",
}

// judge classifies a single condition. It reports false when the condition
// says nothing about health, which is the case for unknown condition types:
// guessing their polarity would paint healthy resources red.
func judge(c Condition) (Status, bool) {
	switch {
	case c.Type == "Stalled" || c.Type == "Reconciling":
		// Both describe work that has not finished; a stalled resource is
		// stuck rather than failed.
		if c.Status == "True" {
			return Yellow, true
		}
		return Green, true
	case isFailureType(c.Type):
		if c.Status == "True" {
			return Red, true
		}
		return Green, true
	case readinessTypes[c.Type] || strings.HasSuffix(c.Type, "Ready"):
		switch c.Status {
		case "True":
			return Green, true
		case "False":
			if isInProgressReason(c.Reason) {
				return Yellow, true
			}
			return Red, true
		default:
			return Yellow, true
		}
	}
	return "", false
}

func isFailureType(conditionType string) bool {
	for _, suffix := range failureSuffixes {
		if strings.HasSuffix(conditionType, suffix) {
			return true
		}
	}
	return false
}

func isInProgressReason(reason string) bool {
	reason = strings.ToLower(reason)
	for _, fragment := range inProgressReasons {
		if strings.Contains(reason, fragment) {
			return true
		}
	}
	return false
}

// describe renders a condition as a short reason such as
// "parents[0]: Accepted is False: NotAllowedByListeners".
func describe(c Condition) string {
	var b strings.Builder
	if c.Source != "" {
		b.WriteString(c.Source)
		b.WriteString(": ")
	}
	fmt.Fprintf(&b, "%s is %s", c.Type, c.Status)
	if c.Reason != "" {
		b.WriteString(": ")
		b.WriteString(c.Reason)
	}
	return b.String()
}

// stale reports whether the controller has not yet observed the latest
// change to the resource's spec.
func stale(obj map[string]any) bool {
	generation, ok := integer(obj, "metadata", "generation")
	if !ok {
		return false
	}
	observed, ok := integer(obj, "status", "observedGeneration")
	return ok && observed < generation
}

func staleResult() Result {
	return Result{Status: Yellow, Reason: "waiting for the controller to observe the latest change"}
}

// isUnclaimedRoute reports whether obj is a Gateway API route that names
// parents but has not been picked up by any of them.
func isUnclaimedRoute(obj map[string]any) bool {
	if apiGroup(obj) != "gateway.networking.k8s.io" || !strings.HasSuffix(str(obj, "kind"), "Route") {
		return false
	}
	return len(list(obj, "spec", "parentRefs")) > 0 && len(list(obj, "status", "parents")) == 0
}

func rank(s Status) int {
	switch s {
	case Red:
		return 2
	case Yellow:
		return 1
	}
	return 0
}
