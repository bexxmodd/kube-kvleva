package kube

import (
	"context"
	"fmt"
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// maxEvents bounds how many Events are fetched for one resource.
const maxEvents = 500

var (
	eventsGVR     = schema.GroupVersionResource{Version: "v1", Resource: "events"}
	configMapsGVR = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
)

// Event is a Kubernetes Event about a resource.
type Event struct {
	// Type is "Normal" or "Warning".
	Type      string `json:"type"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Count     int64  `json:"count"`
	FirstSeen string `json:"firstSeen"`
	LastSeen  string `json:"lastSeen"`
	// Source is the component that reported the event.
	Source string `json:"source"`
	// FieldPath names the part of the resource the event is about, for
	// example "spec.containers{app}".
	FieldPath string `json:"-"`
}

// ListEvents returns the Events about the resource with the given uid,
// newest first. namespace is the namespace of the resource; cluster-scoped
// resources ("" namespace) have their Events looked up in every namespace.
func ListEvents(ctx context.Context, client dynamic.Interface, namespace, uid string) ([]Event, error) {
	options := metav1.ListOptions{
		FieldSelector: "involvedObject.uid=" + uid,
		Limit:         maxEvents,
	}
	list, err := client.Resource(eventsGVR).Namespace(namespace).List(ctx, options)
	if err != nil {
		return nil, fmt.Errorf("listing events: %w", err)
	}
	events := make([]Event, 0, len(list.Items))
	for _, item := range list.Items {
		content := item.Object
		involved, _ := content["involvedObject"].(map[string]any)
		// The field selector already narrows the list; checking again keeps
		// the result right even if a server ignores it.
		if involved["uid"] != uid {
			continue
		}
		event := Event{
			Type:      text(content["type"]),
			Reason:    text(content["reason"]),
			Message:   text(content["message"]),
			Count:     1,
			FirstSeen: firstText(content["firstTimestamp"], content["eventTime"]),
			LastSeen:  firstText(content["lastTimestamp"], content["eventTime"]),
			Source:    firstText(source(content), content["reportingComponent"]),
			FieldPath: text(involved["fieldPath"]),
		}
		if count, ok := content["count"].(int64); ok && count > 0 {
			event.Count = count
		}
		events = append(events, event)
	}
	sort.SliceStable(events, func(i, j int) bool {
		return timestamp(events[i].LastSeen).After(timestamp(events[j].LastSeen))
	})
	return events, nil
}

func source(event map[string]any) any {
	src, _ := event["source"].(map[string]any)
	return src["component"]
}

func text(v any) string {
	s, _ := v.(string)
	return s
}

func firstText(values ...any) string {
	for _, v := range values {
		if s := text(v); s != "" {
			return s
		}
	}
	return ""
}

func timestamp(value string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return t
}
