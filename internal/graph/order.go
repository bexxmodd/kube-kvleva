package graph

// displayOrder lists kind identifiers in the order they are shown: traffic
// entry points first, then what serves the traffic, then what the workloads
// consume. Kinds not listed here follow, sorted by identifier.
var displayOrder = []string{
	"core/Namespace",
	"core/Node",

	"gateway.networking.k8s.io/GatewayClass",
	"gateway.networking.k8s.io/Gateway",
	"gateway.networking.k8s.io/HTTPRoute",
	"gateway.networking.k8s.io/GRPCRoute",
	"gateway.networking.k8s.io/TLSRoute",
	"gateway.networking.k8s.io/TCPRoute",
	"gateway.networking.k8s.io/UDPRoute",
	"gateway.networking.k8s.io/ReferenceGrant",
	"networking.k8s.io/IngressClass",
	"networking.k8s.io/Ingress",

	"core/Service",
	"discovery.k8s.io/EndpointSlice",
	"networking.k8s.io/NetworkPolicy",

	"apps/Deployment",
	"apps/StatefulSet",
	"apps/DaemonSet",
	"batch/CronJob",
	"batch/Job",
	"apps/ReplicaSet",
	"core/ReplicationController",
	"core/Pod",

	"autoscaling/HorizontalPodAutoscaler",
	"policy/PodDisruptionBudget",

	"core/ConfigMap",
	"core/Secret",
	"core/ServiceAccount",

	"core/PersistentVolumeClaim",
	"core/PersistentVolume",
	"storage.k8s.io/StorageClass",

	"rbac.authorization.k8s.io/Role",
	"rbac.authorization.k8s.io/RoleBinding",
	"rbac.authorization.k8s.io/ClusterRole",
	"rbac.authorization.k8s.io/ClusterRoleBinding",

	"apiextensions.k8s.io/CustomResourceDefinition",
}

var ranks = func() map[string]int {
	m := make(map[string]int, len(displayOrder))
	for i, kindID := range displayOrder {
		m[kindID] = i
	}
	return m
}()

// rankOf returns the position of a kind in the display order.
func rankOf(kindID string) int {
	if rank, ok := ranks[kindID]; ok {
		return rank
	}
	return len(displayOrder)
}

// before reports whether a is displayed before b: by kind in display order,
// then by namespace and name.
func before(a, b *object) bool {
	if a.rank != b.rank {
		return a.rank < b.rank
	}
	if a.kindID != b.kindID {
		return a.kindID < b.kindID
	}
	if a.namespace != b.namespace {
		return a.namespace < b.namespace
	}
	return a.name < b.name
}
