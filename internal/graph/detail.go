package graph

import (
	"fmt"
	"sort"

	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/yaml"

	"github.com/bexxmodd/kube-kvleva/internal/health"
)

// Detail returns everything known about the resource with the given uid. It
// reports false when there is no such resource.
func (s *Store) Detail(uid string) (Detail, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	o, ok := s.objects[uid]
	if !ok {
		return Detail{}, false
	}
	detail := Detail{
		Summary:    s.summarize(o, filter{}),
		Conditions: make([]Condition, 0),
		Owners:     make([]Link, 0),
		Missing:    make([]MissingRef, 0),
		Incoming:   s.incoming(o),
	}
	detail.Outgoing, _ = s.links(o, maxDetailLinks)

	obj, err := o.decode()
	if err != nil {
		detail.YAML = fmt.Sprintf("# The manifest could not be read: %v\n", err)
	} else {
		for _, c := range health.Conditions(obj) {
			detail.Conditions = append(detail.Conditions, Condition{
				Type:               c.Type,
				Status:             c.Status,
				Reason:             c.Reason,
				Message:            c.Message,
				LastTransitionTime: c.LastTransitionTime,
				Source:             c.Source,
			})
		}
		if status, ok := obj["status"].(map[string]any); ok && len(status) > 0 {
			detail.StatusYAML = toYAML(status)
		}
		delete(obj, "status")
		detail.YAML = toYAML(obj)
	}

	for _, owner := range o.owners {
		if target, ok := s.objects[owner.UID]; ok {
			detail.Owners = append(detail.Owners, s.link(target, ""))
		}
	}
	for _, r := range o.refs {
		if s.resolve(o, r) != nil {
			continue
		}
		missing := MissingRef{Kind: r.Kind, KindID: r.Kind, Namespace: r.Namespace, Name: r.Name, Relation: r.Relation}
		if r.Group != "" {
			missing.KindID = r.Group + "/" + r.Kind
		}
		if missing.Namespace == "" && !s.isClusterScoped(missing.KindID) {
			missing.Namespace = o.namespace
		}
		detail.Missing = append(detail.Missing, missing)
	}
	return detail, true
}

// isClusterScoped reports whether kindID is a known kind that is not
// namespaced.
func (s *Store) isClusterScoped(kindID string) bool {
	state, ok := s.kinds[kindID]
	return ok && !state.kind.Namespaced
}

// incoming returns links to the resources that refer to o.
func (s *Store) incoming(o *object) []Link {
	var sources []*object
	relations := make(map[string]string)
	for _, candidate := range s.objects {
		if candidate == o {
			continue
		}
		if relation, ok := s.refersTo(candidate, o); ok {
			sources = append(sources, candidate)
			relations[candidate.uid] = relation
		}
	}
	sort.Slice(sources, func(i, j int) bool { return before(sources[i], sources[j]) })
	if len(sources) > maxDetailLinks {
		sources = sources[:maxDetailLinks]
	}
	links := make([]Link, 0, len(sources))
	for _, source := range sources {
		links = append(links, s.link(source, relations[source.uid]))
	}
	return links
}

// refersTo reports whether src has a reference to target, and through which
// relation.
func (s *Store) refersTo(src, target *object) (string, bool) {
	for _, owner := range src.owners {
		if owner.UID == target.uid && s.parentOf(src) != target {
			return "ownerReferences", true
		}
	}
	for _, r := range src.refs {
		// Comparing kind and name first avoids resolving references that
		// cannot possibly point at target.
		if r.Kind == target.kind && r.Name == target.name && s.resolve(src, r) == target {
			return r.Relation, true
		}
	}
	selects := target.kindID == podKindID && src.selector != nil && src.namespace == target.namespace
	if selects && src.selector.Matches(labels.Set(target.labels)) {
		return src.selector.Relation, true
	}
	return "", false
}

// Container returns everything known about the named container of the Pod
// with the given uid. It reports false when there is no such container.
func (s *Store) Container(uid, name string) (ContainerDetail, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	o, ok := s.objects[uid]
	if !ok {
		return ContainerDetail{}, false
	}
	for _, c := range o.containers {
		if c.Name != name {
			continue
		}
		detail := ContainerDetail{Pod: s.summarize(o, filter{}), Container: c}
		obj, err := o.decode()
		if err != nil {
			detail.YAML = fmt.Sprintf("# The manifest could not be read: %v\n", err)
			return detail, true
		}
		specField, statusField := "containers", "containerStatuses"
		if c.Init {
			specField, statusField = "initContainers", "initContainerStatuses"
		}
		if spec, ok := named(obj, "spec", specField, name); ok {
			detail.YAML = toYAML(spec)
		}
		if status, ok := named(obj, "status", statusField, name); ok {
			detail.StatusYAML = toYAML(status)
		}
		return detail, true
	}
	return ContainerDetail{}, false
}

// named returns the entry called name of the list obj[section][field].
func named(obj map[string]any, section, field, name string) (map[string]any, bool) {
	parent, _ := obj[section].(map[string]any)
	items, _ := parent[field].([]any)
	for _, item := range items {
		if entry, ok := item.(map[string]any); ok && entry["name"] == name {
			return entry, true
		}
	}
	return nil, false
}

func toYAML(v any) string {
	out, err := yaml.Marshal(v)
	if err != nil {
		return fmt.Sprintf("# This could not be rendered as YAML: %v\n", err)
	}
	return string(out)
}
