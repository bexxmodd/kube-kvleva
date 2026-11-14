// Package graph holds the in-memory model of a cluster: every resource with
// its health, what it contains, and what it refers to. It answers the
// questions the web interface asks (overview, paginated lists, details) and
// tells subscribers when something changed.
//
// The model is built for large clusters. Each resource is reduced to a small
// summary plus its compressed manifest, lists are paginated, and nothing is
// computed for resources that are not part of an answer.
package graph

import (
	"github.com/bexxmodd/kube-kvleva/internal/health"
)

// CoreGroup is how the core API group is spelled in kind identifiers.
const CoreGroup = "core"

const (
	namespaceKindID = "core/Namespace"
	nodeKindID      = "core/Node"
	podKindID       = "core/Pod"
	secretKindID    = "core/Secret"
)

// Kind identifies a resource type.
type Kind struct {
	// Group is the API group; the core group is "".
	Group      string
	Version    string
	Kind       string
	Namespaced bool
}

// ID returns the kind identifier "<group>/<Kind>", with the core group
// spelled "core".
func (k Kind) ID() string {
	return displayGroup(k.Group) + "/" + k.Kind
}

func displayGroup(group string) string {
	if group == "" {
		return CoreGroup
	}
	return group
}

// Rollup counts resources by health.
type Rollup struct {
	Green  int `json:"green"`
	Yellow int `json:"yellow"`
	Red    int `json:"red"`
}

func (r *Rollup) add(status health.Status) {
	switch status {
	case health.Red:
		r.Red++
	case health.Yellow:
		r.Yellow++
	default:
		r.Green++
	}
}

// Container is one container of a Pod.
type Container struct {
	Name     string        `json:"name"`
	Image    string        `json:"image"`
	Init     bool          `json:"init"`
	Health   health.Status `json:"health"`
	State    string        `json:"state"`
	Reason   string        `json:"reason"`
	Ready    bool          `json:"ready"`
	Restarts int64         `json:"restarts"`
}

// Link points at a resource, optionally naming how it is related.
type Link struct {
	UID       string        `json:"uid"`
	KindID    string        `json:"kindId"`
	Kind      string        `json:"kind"`
	Namespace string        `json:"namespace"`
	Name      string        `json:"name"`
	Health    health.Status `json:"health"`
	// Path lists the containers of the resource, outermost first; see
	// Summary.Path.
	Path []string `json:"path"`
	// Relation is the field the reference was declared in. It is empty for
	// ownership links.
	Relation string `json:"relation,omitempty"`
}

// MissingRef is a reference whose target does not exist in the cluster.
type MissingRef struct {
	KindID    string `json:"kindId"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Relation  string `json:"relation"`
}

// Summary is what a widget needs to know about a resource.
type Summary struct {
	UID       string        `json:"uid"`
	KindID    string        `json:"kindId"`
	Group     string        `json:"group"`
	Version   string        `json:"version"`
	Kind      string        `json:"kind"`
	Namespace string        `json:"namespace"`
	Name      string        `json:"name"`
	Health    health.Status `json:"health"`
	Reason    string        `json:"reason"`
	CreatedAt string        `json:"createdAt,omitempty"`
	// ChildCount is the number of resources displayed directly inside this
	// one, after hidden kinds are skipped.
	ChildCount int `json:"childCount"`
	// Rollup counts this resource and everything nested in it.
	Rollup Rollup `json:"rollup"`
	// SelfMatch is false when the resource is listed only because something
	// nested in it matched the health or text filter.
	SelfMatch bool `json:"selfMatch"`
	// Path lists the containers of the resource, outermost first: "cluster"
	// or "ns:<namespace>", followed by the uids of its owners.
	Path       []string    `json:"path"`
	Node       string      `json:"node,omitempty"`
	Containers []Container `json:"containers,omitempty"`
	// Refs are the outgoing references whose target exists, capped at
	// maxSummaryRefs.
	Refs          []Link `json:"refs"`
	RefsTruncated bool   `json:"refsTruncated"`
}

// Condition is a status condition of a resource.
type Condition struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
	LastTransitionTime string `json:"lastTransitionTime,omitempty"`
	Source             string `json:"source"`
}

// Detail is everything known about one resource.
type Detail struct {
	Summary Summary `json:"summary"`
	// YAML is the manifest without status and bookkeeping fields.
	YAML string `json:"yaml"`
	// StatusYAML is the status of the resource, or "" when it has none.
	StatusYAML string       `json:"statusYaml"`
	Conditions []Condition  `json:"conditions"`
	Owners     []Link       `json:"owners"`
	Outgoing   []Link       `json:"outgoing"`
	Incoming   []Link       `json:"incoming"`
	Missing    []MissingRef `json:"missing"`
}

// ContainerDetail is everything known about one container of a Pod.
type ContainerDetail struct {
	Pod        Summary   `json:"pod"`
	Container  Container `json:"container"`
	YAML       string    `json:"yaml"`
	StatusYAML string    `json:"statusYaml"`
}

// Scope selects which resources a Query lists.
type Scope int

const (
	// ScopeAll lists every resource, flat.
	ScopeAll Scope = iota
	// ScopeNamespace lists the top-level resources of the namespace named
	// by Query.Target.
	ScopeNamespace
	// ScopeCluster lists the top-level cluster-scoped resources other than
	// Namespaces and Nodes.
	ScopeCluster
	// ScopeNodes lists the Nodes.
	ScopeNodes
	// ScopeChildren lists the resources nested directly inside the resource
	// whose uid is Query.Target.
	ScopeChildren
	// ScopePodsOnNode lists the Pods scheduled on the node named by
	// Query.Target, flat.
	ScopePodsOnNode
)

// Limits on the size of a page.
const (
	DefaultLimit = 100
	MaxLimit     = 500
)

// Query describes one page of a resource list.
type Query struct {
	Scope  Scope
	Target string
	// HideKinds lists kind identifiers to leave out. In the tree scopes a
	// hidden resource is replaced by the resources nested in it.
	HideKinds []string
	// Health keeps only resources with one of these health values. Empty
	// keeps all. In the tree scopes a resource is also kept when something
	// nested in it matches.
	Health []string
	// Text keeps only resources whose name contains it, ignoring case. The
	// tree scopes treat it like Health.
	Text string
	// Limit is the page size; 0 means DefaultLimit and it is capped at
	// MaxLimit.
	Limit  int
	Offset int
}

// Page is one page of a resource list.
type Page struct {
	Items []Summary `json:"items"`
	// Total is the number of matching resources before pagination.
	Total    int    `json:"total"`
	Offset   int    `json:"offset"`
	Limit    int    `json:"limit"`
	Revision uint64 `json:"revision"`
}

// Overview summarizes the whole cluster.
type Overview struct {
	Revision      uint64             `json:"revision"`
	Sync          Sync               `json:"sync"`
	Health        Rollup             `json:"health"`
	Kinds         []KindSummary      `json:"kinds"`
	Namespaces    []NamespaceSummary `json:"namespaces"`
	ClusterScoped Area               `json:"clusterScoped"`
	Nodes         Area               `json:"nodes"`
}

// Sync reports how far loading the cluster has progressed.
type Sync struct {
	// Ready is true once every known kind has been loaded or has failed to.
	Ready       bool        `json:"ready"`
	KindsTotal  int         `json:"kindsTotal"`
	KindsSynced int         `json:"kindsSynced"`
	Errors      []KindError `json:"errors"`
}

// KindError is the reason a kind could not be loaded.
type KindError struct {
	KindID  string `json:"kindId"`
	Message string `json:"message"`
}

// KindSummary counts the resources of one kind.
type KindSummary struct {
	KindID     string `json:"kindId"`
	Group      string `json:"group"`
	Version    string `json:"version"`
	Kind       string `json:"kind"`
	Namespaced bool   `json:"namespaced"`
	Count      int    `json:"count"`
	Rollup     Rollup `json:"rollup"`
}

// NamespaceSummary describes a namespace and counts what is inside it.
type NamespaceSummary struct {
	Name string `json:"name"`
	// UID is the uid of the Namespace object, or "" when it is not loaded.
	UID    string        `json:"uid"`
	Health health.Status `json:"health"`
	Reason string        `json:"reason"`
	Count  int           `json:"count"`
	Rollup Rollup        `json:"rollup"`
}

// Area counts the resources of one area of the cluster view.
type Area struct {
	Count  int    `json:"count"`
	Rollup Rollup `json:"rollup"`
}

// Change is a batch of changes reported to a Subscription.
type Change struct {
	Revision uint64   `json:"revision"`
	Changed  []string `json:"changed"`
	Deleted  []string `json:"deleted"`
	// Overflow is true when the batch was too large to enumerate; Changed
	// and Deleted are then empty and everything should be refreshed.
	Overflow bool `json:"overflow"`
}
