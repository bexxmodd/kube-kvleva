package kube

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func clusterEvent(name string, fields map[string]any) *unstructured.Unstructured {
	content := map[string]any{
		"apiVersion": "v1",
		"kind":       "Event",
		"metadata":   map[string]any{"namespace": "default", "name": name},
	}
	for key, value := range fields {
		content[key] = value
	}
	return &unstructured.Unstructured{Object: content}
}

func TestListEvents(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{eventsGVR: "EventList"}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		clusterEvent("web.older", map[string]any{
			"involvedObject": map[string]any{"uid": "pod-web", "fieldPath": "spec.containers{app}"},
			"type":           "Normal",
			"reason":         "Pulled",
			"message":        "Container image already present",
			"count":          int64(1),
			"firstTimestamp": "2026-11-14T17:00:00Z",
			"lastTimestamp":  "2026-11-14T17:00:00Z",
			"source":         map[string]any{"component": "kubelet"},
		}),
		clusterEvent("web.newer", map[string]any{
			"involvedObject": map[string]any{"uid": "pod-web", "fieldPath": "spec.containers{app}"},
			"type":           "Warning",
			"reason":         "BackOff",
			"message":        "Back-off restarting failed container",
			"count":          int64(7),
			"firstTimestamp": "2026-11-14T17:01:00Z",
			"lastTimestamp":  "2026-11-14T17:05:00Z",
			"source":         map[string]any{"component": "kubelet"},
		}),
		clusterEvent("web.series", map[string]any{
			"involvedObject":      map[string]any{"uid": "pod-web"},
			"type":                "Normal",
			"reason":              "Scheduled",
			"message":             "Successfully assigned default/web",
			"eventTime":           "2026-11-14T16:59:00.000000Z",
			"reportingComponent":  "default-scheduler",
			"firstTimestamp":      nil,
			"lastTimestamp":       nil,
			"deprecatedFirstSeen": nil,
		}),
		clusterEvent("other.event", map[string]any{
			"involvedObject": map[string]any{"uid": "pod-other"},
			"type":           "Warning",
			"reason":         "Failed",
			"lastTimestamp":  "2026-11-14T17:06:00Z",
		}),
	)

	got, err := ListEvents(t.Context(), client, "default", "pod-web")
	if err != nil {
		t.Fatalf("ListEvents(default, pod-web) failed: %v", err)
	}
	want := []Event{
		{
			Type: "Warning", Reason: "BackOff", Message: "Back-off restarting failed container", Count: 7,
			FirstSeen: "2026-11-14T17:01:00Z", LastSeen: "2026-11-14T17:05:00Z", Source: "kubelet",
			FieldPath: "spec.containers{app}",
		},
		{
			Type: "Normal", Reason: "Pulled", Message: "Container image already present", Count: 1,
			FirstSeen: "2026-11-14T17:00:00Z", LastSeen: "2026-11-14T17:00:00Z", Source: "kubelet",
			FieldPath: "spec.containers{app}",
		},
		{
			Type: "Normal", Reason: "Scheduled", Message: "Successfully assigned default/web", Count: 1,
			FirstSeen: "2026-11-14T16:59:00.000000Z", LastSeen: "2026-11-14T16:59:00.000000Z", Source: "default-scheduler",
		},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("ListEvents(default, pod-web) diff (-want +got):\n%s", diff)
	}
}
