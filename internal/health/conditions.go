package health

import (
	"fmt"
	"sort"
	"time"
)

// Condition is one entry of a resource's status conditions.
type Condition struct {
	Type               string
	Status             string
	Reason             string
	Message            string
	LastTransitionTime string
	// Source names where a nested condition was reported, for example
	// "parents[0]" for an HTTPRoute or "listeners[1]" for a Gateway. It is
	// empty for status.conditions.
	Source string
}

// Conditions returns every condition obj reports, most recently changed
// first. Besides status.conditions it includes conditions nested one level
// down, as used by the Gateway API (status.parents[].conditions,
// status.listeners[].conditions).
func Conditions(obj map[string]any) []Condition {
	conditions := collectConditions(obj)
	sort.SliceStable(conditions, func(i, j int) bool {
		ti, tj := transitionTime(conditions[i]), transitionTime(conditions[j])
		return ti.After(tj)
	})
	return conditions
}

// collectConditions returns the conditions in the order they are reported:
// status.conditions first, then nested ones by field name.
func collectConditions(obj map[string]any) []Condition {
	status := dict(obj["status"])
	conditions := parseConditions(status["conditions"], "")

	fields := make([]string, 0, len(status))
	for name := range status {
		if name != "conditions" {
			fields = append(fields, name)
		}
	}
	sort.Strings(fields)
	for _, name := range fields {
		items, ok := status[name].([]any)
		if !ok {
			continue
		}
		for i, item := range items {
			source := fmt.Sprintf("%s[%d]", name, i)
			conditions = append(conditions, parseConditions(dict(item)["conditions"], source)...)
		}
	}
	return conditions
}

func parseConditions(raw any, source string) []Condition {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	var conditions []Condition
	for _, item := range items {
		c := dict(item)
		conditionType := str(c, "type")
		if conditionType == "" {
			continue
		}
		conditions = append(conditions, Condition{
			Type:               conditionType,
			Status:             str(c, "status"),
			Reason:             str(c, "reason"),
			Message:            str(c, "message"),
			LastTransitionTime: firstNonEmpty(str(c, "lastTransitionTime"), str(c, "lastUpdateTime"), str(c, "lastProbeTime")),
			Source:             source,
		})
	}
	return conditions
}

// transitionTime parses the condition's timestamp; conditions without a
// usable timestamp sort last.
func transitionTime(c Condition) time.Time {
	t, err := time.Parse(time.RFC3339, c.LastTransitionTime)
	if err != nil {
		return time.Time{}
	}
	return t
}

// condition returns the status.conditions entry of the given type.
func condition(obj map[string]any, conditionType string) (Condition, bool) {
	for _, c := range parseConditions(dict(obj["status"])["conditions"], "") {
		if c.Type == conditionType {
			return c, true
		}
	}
	return Condition{}, false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
