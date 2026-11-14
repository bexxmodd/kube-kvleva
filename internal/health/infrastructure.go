package health

import "strings"

func node(obj map[string]any) Result {
	ready, ok := condition(obj, "Ready")
	if !ok {
		return Result{Status: Yellow, Reason: "not reporting yet"}
	}
	if ready.Status != "True" {
		return Result{Status: Red, Reason: describe(ready)}
	}
	if c, ok := condition(obj, "NetworkUnavailable"); ok && c.Status == "True" {
		return Result{Status: Red, Reason: describe(c)}
	}
	for _, c := range collectConditions(obj) {
		if strings.HasSuffix(c.Type, "Pressure") && c.Status == "True" {
			return Result{Status: Yellow, Reason: describe(c)}
		}
	}
	if unschedulable, _ := field(obj, "spec", "unschedulable"); unschedulable == true {
		return Result{Status: Green, Reason: "Ready, scheduling disabled"}
	}
	return Result{Status: Green, Reason: "Ready"}
}

func persistentVolumeClaim(obj map[string]any) Result {
	phase := str(obj, "status", "phase")
	switch phase {
	case "Bound":
		return Result{Status: Green, Reason: phase}
	case "Lost":
		return Result{Status: Red, Reason: phase}
	}
	return Result{Status: Yellow, Reason: firstNonEmpty(phase, "Pending")}
}

func persistentVolume(obj map[string]any) Result {
	phase := str(obj, "status", "phase")
	switch phase {
	case "Available", "Bound":
		return Result{Status: Green, Reason: phase}
	case "Failed":
		return Result{Status: Red, Reason: phase}
	}
	return Result{Status: Yellow, Reason: firstNonEmpty(phase, "Pending")}
}

func namespace(obj map[string]any) Result {
	phase := str(obj, "status", "phase")
	if phase == "Terminating" {
		return Result{Status: Yellow, Reason: phase}
	}
	return Result{Status: Green, Reason: firstNonEmpty(phase, "Active")}
}

func service(obj map[string]any) Result {
	isLoadBalancer := str(obj, "spec", "type") == "LoadBalancer"
	if isLoadBalancer && len(list(obj, "status", "loadBalancer", "ingress")) == 0 {
		return Result{Status: Yellow, Reason: "waiting for a load balancer address"}
	}
	return Result{Status: Green}
}
