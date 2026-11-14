// Package refs finds the relationships a Kubernetes resource declares: the
// resources that own it and the resources it refers to by name or by label.
//
// Like package health it works on the generic, decoded form of an object, so
// built-in kinds and custom resources are handled by the same code. Custom
// resources are covered by convention: any field whose name ends in "Ref" or
// "Refs" and holds an object with a name is treated as a reference.
package refs

import (
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
)

// CoreGroup is how the Kubernetes core API group ("" on the wire) is spelled
// in a Ref, so that the empty string can mean "not specified".
const CoreGroup = "core"

// Ref is a reference by name from one resource to another.
type Ref struct {
	// Group is the API group of the target, CoreGroup for the core group, or
	// "" when the reference does not say and any group may match.
	Group string
	Kind  string
	// Namespace is the namespace of the target, or "" when the reference
	// does not say: the target then lives in the referring resource's
	// namespace or is cluster-scoped.
	Namespace string
	Name      string
	// Relation is the name of the field the reference was found in.
	Relation string
}

// PodSelector is a reference to the Pods, in the referring resource's
// namespace, whose labels the selector matches.
type PodSelector struct {
	labels.Selector
	// Relation is the name of the field the selector was found in.
	Relation string
}

// Owner is an entry of metadata.ownerReferences.
type Owner struct {
	UID        string
	Group      string
	Kind       string
	Name       string
	Controller bool
}

// Relations are all relationships one resource declares.
type Relations struct {
	// Owners lists the owner references, the controlling owner first.
	Owners []Owner
	// Refs lists the distinct references by name, sorted by kind, namespace,
	// and name.
	Refs []Ref
	// PodSelector is nil when the resource does not select Pods.
	PodSelector *PodSelector
}

// Extract returns the relationships declared by obj, the decoded content of
// a Kubernetes object.
func Extract(obj map[string]any) Relations {
	c := collector{sourceGroup: groupOf(text(obj["apiVersion"])), seen: make(map[Ref]bool)}
	for _, key := range sortedKeys(obj) {
		// metadata holds no references besides ownerReferences, and status
		// describes what was observed rather than what is declared.
		if key == "metadata" || key == "status" {
			continue
		}
		c.visit(key, obj[key])
	}
	sort.Slice(c.refs, func(i, j int) bool {
		a, b := c.refs[i], c.refs[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.Group < b.Group
	})
	return Relations{
		Owners:      owners(obj),
		Refs:        c.refs,
		PodSelector: podSelector(obj),
	}
}

type target struct {
	group, kind string
}

// nameFields are fields that hold the bare name of a resource of a fixed
// kind.
var nameFields = map[string]target{
	"serviceAccountName": {CoreGroup, "ServiceAccount"},
	"nodeName":           {CoreGroup, "Node"},
	"volumeName":         {CoreGroup, "PersistentVolume"},
	"claimName":          {CoreGroup, "PersistentVolumeClaim"},
	"secretName":         {CoreGroup, "Secret"},
	"serviceName":        {CoreGroup, "Service"},
	"storageClassName":   {"storage.k8s.io", "StorageClass"},
	"gatewayClassName":   {"gateway.networking.k8s.io", "GatewayClass"},
	"ingressClassName":   {"networking.k8s.io", "IngressClass"},
	"priorityClassName":  {"scheduling.k8s.io", "PriorityClass"},
	"runtimeClassName":   {"node.k8s.io", "RuntimeClass"},
}

// objectFields are fields that hold an object, or a list of objects, naming
// a resource of a fixed kind, such as a volume's "configMap: {name: …}".
var objectFields = map[string]target{
	"configMap":        {CoreGroup, "ConfigMap"},
	"secret":           {CoreGroup, "Secret"},
	"service":          {CoreGroup, "Service"},
	"imagePullSecrets": {CoreGroup, "Secret"},
	"secrets":          {CoreGroup, "Secret"},
}

// collector accumulates the distinct references found while walking an
// object.
type collector struct {
	// sourceGroup is the API group of the object being walked.
	sourceGroup string
	refs        []Ref
	seen        map[Ref]bool
}

func (c *collector) add(r Ref) {
	if r.Kind == "" || r.Name == "" {
		return
	}
	// The same target reached through different fields is one relationship.
	identity := r
	identity.Relation = ""
	if c.seen[identity] {
		return
	}
	c.seen[identity] = true
	c.refs = append(c.refs, r)
}

// visit inspects the field named key holding value, then descends into it.
func (c *collector) visit(key string, value any) {
	switch v := value.(type) {
	case string:
		if t, ok := nameFields[key]; ok {
			c.add(Ref{Group: t.group, Kind: t.kind, Name: v, Relation: key})
		}
	case map[string]any:
		if c.visitObject(key, v) {
			return
		}
		for _, k := range sortedKeys(v) {
			c.visit(k, v[k])
		}
	case []any:
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				if c.visitObject(key, m) {
					continue
				}
				for _, k := range sortedKeys(m) {
					c.visit(k, m[k])
				}
			}
		}
	}
}

// visitObject handles an object found in the field named key. It reports
// whether the object was a reference, in which case its fields are not
// searched further.
func (c *collector) visitObject(key string, m map[string]any) bool {
	name := text(m["name"])
	if name == "" {
		return false
	}
	namespace := text(m["namespace"])
	switch {
	case key == "subjects":
		// RBAC subjects also name users and groups, which are not resources.
		if text(m["kind"]) == "ServiceAccount" {
			c.add(Ref{Group: CoreGroup, Kind: "ServiceAccount", Namespace: namespace, Name: name, Relation: key})
		}
		return true
	case isRefField(key):
		t, ok := c.refTarget(key, m)
		if !ok {
			return false
		}
		c.add(Ref{Group: t.group, Kind: t.kind, Namespace: namespace, Name: name, Relation: key})
		return true
	}
	if t, ok := objectFields[key]; ok {
		c.add(Ref{Group: t.group, Kind: t.kind, Namespace: namespace, Name: name, Relation: key})
		return true
	}
	return false
}

// isRefField reports whether a field name follows the "…Ref" / "…Refs"
// naming convention for object references.
func isRefField(key string) bool {
	lower := strings.ToLower(key)
	for _, suffix := range []string{"ref", "refs", "reference", "references"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

// refTarget determines the kind a "…Ref" object points at: the kind it
// states, or else the kind implied by the field name. It reports false when
// neither tells.
func (c *collector) refTarget(key string, m map[string]any) (target, bool) {
	if kind := text(m["kind"]); kind != "" {
		return target{group: statedGroup(m), kind: kind}, true
	}
	lower := strings.ToLower(key)
	switch {
	case strings.Contains(lower, "secret"):
		return target{CoreGroup, "Secret"}, true
	case strings.Contains(lower, "configmap"):
		return target{CoreGroup, "ConfigMap"}, true
	case strings.Contains(lower, "serviceaccount"):
		return target{CoreGroup, "ServiceAccount"}, true
	}
	// The Gateway API omits kinds that have a default.
	if c.sourceGroup == "gateway.networking.k8s.io" {
		switch strings.TrimSuffix(lower, "s") {
		case "parentref":
			return target{"gateway.networking.k8s.io", "Gateway"}, true
		case "backendref":
			return target{CoreGroup, "Service"}, true
		case "certificateref":
			return target{CoreGroup, "Secret"}, true
		}
	}
	return target{}, false
}

// statedGroup returns the API group a reference object states through its
// group, apiGroup, or apiVersion field, or "" when it states none.
func statedGroup(m map[string]any) string {
	for _, field := range []string{"group", "apiGroup"} {
		if v, ok := m[field].(string); ok {
			if v == "" {
				return CoreGroup
			}
			return v
		}
	}
	if apiVersion := text(m["apiVersion"]); apiVersion != "" {
		return groupOf(apiVersion)
	}
	return ""
}

// groupOf returns the group of an apiVersion such as "apps/v1" or "v1".
func groupOf(apiVersion string) string {
	group, _, hasGroup := strings.Cut(apiVersion, "/")
	if !hasGroup {
		return CoreGroup
	}
	return group
}

func owners(obj map[string]any) []Owner {
	metadata, _ := obj["metadata"].(map[string]any)
	raw, _ := metadata["ownerReferences"].([]any)
	var result []Owner
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		controller, _ := m["controller"].(bool)
		result = append(result, Owner{
			UID:        text(m["uid"]),
			Group:      groupOf(text(m["apiVersion"])),
			Kind:       text(m["kind"]),
			Name:       text(m["name"]),
			Controller: controller,
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].Controller && !result[j].Controller
	})
	return result
}

// podSelector returns the label selector of the kinds whose selector is a
// relationship worth drawing. Workload selectors are left out because
// ownership already connects workloads to their Pods.
func podSelector(obj map[string]any) *PodSelector {
	spec, _ := obj["spec"].(map[string]any)
	kind := text(obj["kind"])
	switch groupOf(text(obj["apiVersion"])) + "/" + kind {
	case "core/Service":
		set := make(labels.Set)
		raw, _ := spec["selector"].(map[string]any)
		for k, v := range raw {
			set[k] = text(v)
		}
		if len(set) == 0 {
			return nil
		}
		return &PodSelector{Selector: labels.SelectorFromSet(set), Relation: "selector"}
	case "policy/PodDisruptionBudget":
		return labelSelector(spec, "selector")
	case "networking.k8s.io/NetworkPolicy":
		return labelSelector(spec, "podSelector")
	}
	return nil
}

// labelSelector converts the metav1.LabelSelector in the named field. An
// empty selector, which selects every Pod, is not reported: drawing an edge
// to everything says nothing.
func labelSelector(spec map[string]any, fieldName string) *PodSelector {
	raw, ok := spec[fieldName].(map[string]any)
	if !ok {
		return nil
	}
	var ls metav1.LabelSelector
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(raw, &ls); err != nil {
		return nil
	}
	if len(ls.MatchLabels) == 0 && len(ls.MatchExpressions) == 0 {
		return nil
	}
	selector, err := metav1.LabelSelectorAsSelector(&ls)
	if err != nil {
		return nil
	}
	return &PodSelector{Selector: selector, Relation: fieldName}
}

func text(v any) string {
	s, _ := v.(string)
	return s
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
