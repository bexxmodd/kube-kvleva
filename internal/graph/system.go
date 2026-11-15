package graph

import (
	"strings"
	"time"
)

// System resources are what a cluster brings along, as opposed to what its
// users deploy. A resource is one when it
//
//   - lives in a system namespace (or is that namespace),
//   - is maintained by Kubernetes itself, whenever it was created, or
//   - is a cluster-wide resource installed while the cluster was created.
//
// Nodes and the "default" namespace are never system resources: they are
// where the users' workloads run.

const (
	// bootstrapWindow is how long after the kube-system namespace appeared
	// cluster-wide resources still count as installed with the cluster. It
	// covers what installers add right after the control plane is up (a
	// network plugin's roles, a default storage class) and is kept short
	// because anything created in it is hidden by default.
	bootstrapWindow = 30 * time.Second

	bootstrapNamespace = "kube-system"
	defaultNamespace   = "default"
	// systemNamespacePrefix is reserved by Kubernetes for its own
	// namespaces.
	systemNamespacePrefix = "kube-"
)

// infrastructureNamespaces are namespaces that cluster installers create for
// their own components and that do not carry the reserved prefix.
var infrastructureNamespaces = map[string]bool{
	"local-path-storage": true, // storage provisioner of kind
}

// selfMaintainedLabels mark objects that a Kubernetes component creates and
// keeps reconciling.
var selfMaintainedLabels = []string{
	"kubernetes.io/bootstrapping",               // built-in RBAC roles and bindings
	"kube-aggregator.kubernetes.io/automanaged", // API services of built-in and custom resource groups
	"addonmanager.kubernetes.io/mode",           // add-ons managed by the platform
}

// selfMaintainedAnnotation marks the built-in API priority and fairness
// objects.
const selfMaintainedAnnotation = "apf.kubernetes.io/autoupdate-spec"

// selfMaintainedKinds are kinds whose every object is bookkeeping of a
// Kubernetes component.
var selfMaintainedKinds = map[string]bool{
	"networking.k8s.io/IPAddress": true, // addresses allocated to Services
	"storage.k8s.io/CSINode":      true, // per-node storage registration by the kubelet
}

// selfMaintained reports whether obj, an object of kindID, is recognizably
// maintained by Kubernetes itself, wherever and whenever it was created.
func selfMaintained(kindID string, obj map[string]any) bool {
	metadata, _ := obj["metadata"].(map[string]any)
	name, _ := metadata["name"].(string)
	namespace, _ := metadata["namespace"].(string)

	if selfMaintainedKinds[kindID] {
		return true
	}
	labels, _ := metadata["labels"].(map[string]any)
	for _, label := range selfMaintainedLabels {
		if _, ok := labels[label]; ok {
			return true
		}
	}
	annotations, _ := metadata["annotations"].(map[string]any)
	if _, ok := annotations[selfMaintainedAnnotation]; ok {
		return true
	}
	// Names with a colon cannot collide with ordinary names; these prefixes
	// are used by Kubernetes and by kubeadm for their own objects.
	if strings.HasPrefix(name, "system:") || strings.HasPrefix(name, "kubeadm:") {
		return true
	}

	switch kindID {
	case "core/ConfigMap":
		// The certificate bundle published into every namespace.
		return name == "kube-root-ca.crt"
	case "core/ServiceAccount":
		// Created in every namespace by the service account controller.
		return name == "default"
	case "core/Service", "discovery.k8s.io/EndpointSlice":
		// The API server's own Service and its endpoints.
		return namespace == defaultNamespace && name == "kubernetes"
	case "networking.k8s.io/ServiceCIDR":
		return name == "kubernetes"
	case "scheduling.k8s.io/PriorityClass":
		return strings.HasPrefix(name, "system-")
	case "certificates.k8s.io/CertificateSigningRequest":
		// Requested by nodes for their own certificates.
		spec, _ := obj["spec"].(map[string]any)
		username, _ := spec["username"].(string)
		return strings.HasPrefix(username, "system:")
	}
	return false
}

// isSystem reports whether o is a system resource.
func (s *Store) isSystem(o *object) bool {
	switch {
	case o.kindID == nodeKindID:
		return false
	case o.kindID == namespaceKindID:
		return isSystemNamespace(o.name)
	case o.namespace != "":
		// Namespaced resources are never judged by their age: a user may
		// well deploy an application seconds after creating the cluster.
		return isSystemNamespace(o.namespace) || o.selfMaintained
	}
	return o.selfMaintained || s.installedWithCluster(o)
}

func isSystemNamespace(name string) bool {
	return strings.HasPrefix(name, systemNamespacePrefix) || infrastructureNamespaces[name]
}

// installedWithCluster reports whether o was created while the cluster was
// being created. The cluster's birth is the creation of the kube-system
// namespace; while that is unknown nothing is assumed.
func (s *Store) installedWithCluster(o *object) bool {
	if s.clusterBorn.IsZero() || o.created.IsZero() {
		return false
	}
	return !o.created.After(s.clusterBorn.Add(bootstrapWindow))
}
