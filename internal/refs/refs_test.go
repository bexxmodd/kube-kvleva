package refs

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/yaml"
)

// object parses a YAML manifest into the generic form Extract consumes.
func object(t *testing.T, manifest string) map[string]any {
	t.Helper()
	var obj map[string]any
	if err := yaml.Unmarshal([]byte(manifest), &obj); err != nil {
		t.Fatalf("parsing test manifest: %v\n%s", err, manifest)
	}
	return obj
}

func TestExtractRefs(t *testing.T) {
	tests := []struct {
		name     string
		manifest string
		want     []Ref
	}{
		{
			name: "gateway_class_name",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
spec:
  gatewayClassName: kvleva
`,
			want: []Ref{
				{Group: "gateway.networking.k8s.io", Kind: "GatewayClass", Name: "kvleva", Relation: "gatewayClassName"},
			},
		},
		{
			name: "gateway_listener_certificate",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
spec:
  listeners:
  - name: https
    tls:
      certificateRefs:
      - {name: web-tls}
`,
			want: []Ref{
				{Group: "core", Kind: "Secret", Name: "web-tls", Relation: "certificateRefs"},
			},
		},
		{
			name: "route_parent_defaults_to_gateway",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
  - {name: web}
`,
			want: []Ref{
				{Group: "gateway.networking.k8s.io", Kind: "Gateway", Name: "web", Relation: "parentRefs"},
			},
		},
		{
			name: "route_parent_in_another_namespace",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
  - {group: gateway.networking.k8s.io, kind: Gateway, namespace: infra, name: shared}
`,
			want: []Ref{
				{Group: "gateway.networking.k8s.io", Kind: "Gateway", Namespace: "infra", Name: "shared", Relation: "parentRefs"},
			},
		},
		{
			name: "route_backend_defaults_to_service",
			manifest: `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  rules:
  - backendRefs:
    - {name: checkout, port: 80}
    - {group: "", kind: Service, name: billing, port: 80}
`,
			want: []Ref{
				{Group: "core", Kind: "Service", Name: "billing", Relation: "backendRefs"},
				{Group: "core", Kind: "Service", Name: "checkout", Relation: "backendRefs"},
			},
		},
		{
			name: "ingress",
			manifest: `
apiVersion: networking.k8s.io/v1
kind: Ingress
spec:
  ingressClassName: nginx
  tls:
  - secretName: site-tls
  defaultBackend:
    service: {name: fallback, port: {number: 80}}
  rules:
  - http:
      paths:
      - backend:
          service: {name: web, port: {number: 80}}
`,
			want: []Ref{
				{Group: "networking.k8s.io", Kind: "IngressClass", Name: "nginx", Relation: "ingressClassName"},
				{Group: "core", Kind: "Secret", Name: "site-tls", Relation: "secretName"},
				{Group: "core", Kind: "Service", Name: "fallback", Relation: "service"},
				{Group: "core", Kind: "Service", Name: "web", Relation: "service"},
			},
		},
		{
			name: "pod",
			manifest: `
apiVersion: v1
kind: Pod
spec:
  nodeName: worker-1
  serviceAccountName: builder
  imagePullSecrets:
  - {name: registry}
  volumes:
  - name: config
    configMap: {name: app-config}
  - name: certs
    secret: {secretName: app-certs}
  - name: data
    persistentVolumeClaim: {claimName: app-data}
  - name: bundle
    projected:
      sources:
      - configMap: {name: bundle-config}
      - secret: {name: bundle-secret}
  containers:
  - name: app
    envFrom:
    - configMapRef: {name: env-config}
    - secretRef: {name: env-secret}
    env:
    - name: PASSWORD
      valueFrom:
        secretKeyRef: {name: db, key: password}
    - name: MODE
      valueFrom:
        configMapKeyRef: {name: settings, key: mode}
    - name: POD_NAME
      valueFrom:
        fieldRef: {fieldPath: metadata.name}
`,
			want: []Ref{
				{Group: "core", Kind: "ConfigMap", Name: "app-config", Relation: "configMap"},
				{Group: "core", Kind: "ConfigMap", Name: "bundle-config", Relation: "configMap"},
				{Group: "core", Kind: "ConfigMap", Name: "env-config", Relation: "configMapRef"},
				{Group: "core", Kind: "ConfigMap", Name: "settings", Relation: "configMapKeyRef"},
				{Group: "core", Kind: "Node", Name: "worker-1", Relation: "nodeName"},
				{Group: "core", Kind: "PersistentVolumeClaim", Name: "app-data", Relation: "claimName"},
				{Group: "core", Kind: "Secret", Name: "app-certs", Relation: "secretName"},
				{Group: "core", Kind: "Secret", Name: "bundle-secret", Relation: "secret"},
				{Group: "core", Kind: "Secret", Name: "db", Relation: "secretKeyRef"},
				{Group: "core", Kind: "Secret", Name: "env-secret", Relation: "secretRef"},
				{Group: "core", Kind: "Secret", Name: "registry", Relation: "imagePullSecrets"},
				{Group: "core", Kind: "ServiceAccount", Name: "builder", Relation: "serviceAccountName"},
			},
		},
		{
			name: "workload_pod_template",
			manifest: `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      serviceAccountName: web
      containers:
      - name: app
        envFrom:
        - configMapRef: {name: web-config}
`,
			want: []Ref{
				{Group: "core", Kind: "ConfigMap", Name: "web-config", Relation: "configMapRef"},
				{Group: "core", Kind: "ServiceAccount", Name: "web", Relation: "serviceAccountName"},
			},
		},
		{
			name: "persistent_volume_claim",
			manifest: `
apiVersion: v1
kind: PersistentVolumeClaim
spec:
  volumeName: pv-0001
  storageClassName: fast
`,
			want: []Ref{
				{Group: "core", Kind: "PersistentVolume", Name: "pv-0001", Relation: "volumeName"},
				{Group: "storage.k8s.io", Kind: "StorageClass", Name: "fast", Relation: "storageClassName"},
			},
		},
		{
			name: "persistent_volume_claim_reference",
			manifest: `
apiVersion: v1
kind: PersistentVolume
spec:
  claimRef: {apiVersion: v1, kind: PersistentVolumeClaim, namespace: default, name: app-data}
`,
			want: []Ref{
				{Group: "core", Kind: "PersistentVolumeClaim", Namespace: "default", Name: "app-data", Relation: "claimRef"},
			},
		},
		{
			name: "autoscaler_scale_target",
			manifest: `
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: web}
`,
			want: []Ref{
				{Group: "apps", Kind: "Deployment", Name: "web", Relation: "scaleTargetRef"},
			},
		},
		{
			name: "role_binding",
			manifest: `
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: reader}
subjects:
- {kind: ServiceAccount, name: builder, namespace: ci}
- {kind: User, apiGroup: rbac.authorization.k8s.io, name: alice}
- {kind: Group, apiGroup: rbac.authorization.k8s.io, name: "system:masters"}
`,
			want: []Ref{
				{Group: "rbac.authorization.k8s.io", Kind: "Role", Name: "reader", Relation: "roleRef"},
				{Group: "core", Kind: "ServiceAccount", Namespace: "ci", Name: "builder", Relation: "subjects"},
			},
		},
		{
			name: "service_account_secrets",
			manifest: `
apiVersion: v1
kind: ServiceAccount
secrets:
- {name: builder-token}
imagePullSecrets:
- {name: registry}
`,
			want: []Ref{
				{Group: "core", Kind: "Secret", Name: "builder-token", Relation: "secrets"},
				{Group: "core", Kind: "Secret", Name: "registry", Relation: "imagePullSecrets"},
			},
		},
		{
			name: "stateful_set_service",
			manifest: `
apiVersion: apps/v1
kind: StatefulSet
spec:
  serviceName: db-headless
`,
			want: []Ref{
				{Group: "core", Kind: "Service", Name: "db-headless", Relation: "serviceName"},
			},
		},
		{
			name: "custom_resource_typed_reference",
			manifest: `
apiVersion: cert-manager.io/v1
kind: Certificate
spec:
  secretName: web-tls
  issuerRef: {group: cert-manager.io, kind: ClusterIssuer, name: letsencrypt}
`,
			want: []Ref{
				{Group: "cert-manager.io", Kind: "ClusterIssuer", Name: "letsencrypt", Relation: "issuerRef"},
				{Group: "core", Kind: "Secret", Name: "web-tls", Relation: "secretName"},
			},
		},
		{
			name: "custom_resource_reference_with_kind_but_no_group",
			manifest: `
apiVersion: example.io/v1
kind: Widget
spec:
  sourceRef: {kind: Blueprint, name: base}
`,
			want: []Ref{
				{Kind: "Blueprint", Name: "base", Relation: "sourceRef"},
			},
		},
		{
			name: "custom_resource_secret_reference_inferred_from_field_name",
			manifest: `
apiVersion: example.io/v1
kind: Widget
spec:
  credentialsSecretRef: {name: widget-credentials}
`,
			want: []Ref{
				{Group: "core", Kind: "Secret", Name: "widget-credentials", Relation: "credentialsSecretRef"},
			},
		},
		{
			name: "reference_of_unknown_kind_is_skipped",
			manifest: `
apiVersion: example.io/v1
kind: Widget
spec:
  providerConfigRef: {name: default}
`,
		},
		{
			name: "duplicate_references_are_reported_once",
			manifest: `
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: a
    envFrom:
    - secretRef: {name: shared}
  - name: b
    envFrom:
    - secretRef: {name: shared}
`,
			want: []Ref{
				{Group: "core", Kind: "Secret", Name: "shared", Relation: "secretRef"},
			},
		},
		{
			name: "metadata_and_status_are_not_searched",
			manifest: `
apiVersion: example.io/v1
kind: Widget
metadata:
  annotations: {secretName: not-a-reference}
status:
  secretName: also-not-a-reference
  nodeName: nor-this
`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Extract(object(t, tc.manifest)).Refs
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("Extract(%s).Refs diff (-want +got):\n%s", tc.name, diff)
			}
		})
	}
}

func TestExtractOwners(t *testing.T) {
	pod := object(t, `
apiVersion: v1
kind: Pod
metadata:
  ownerReferences:
  - {apiVersion: example.io/v1, kind: Watcher, name: observer, uid: uid-observer}
  - {apiVersion: apps/v1, kind: ReplicaSet, name: web-7d4b9c, uid: uid-rs, controller: true}
`)
	want := []Owner{
		{UID: "uid-rs", Group: "apps", Kind: "ReplicaSet", Name: "web-7d4b9c", Controller: true},
		{UID: "uid-observer", Group: "example.io", Kind: "Watcher", Name: "observer"},
	}
	got := Extract(pod).Owners
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Extract(pod).Owners diff (-want +got):\n%s", diff)
	}
}

func TestExtractPodSelector(t *testing.T) {
	tests := []struct {
		name         string
		manifest     string
		wantRelation string
		// matches and rejects are pod label sets the selector must and must
		// not select. Both empty means no selector is expected.
		matches labels.Set
		rejects labels.Set
	}{
		{
			name: "service_selector",
			manifest: `
apiVersion: v1
kind: Service
spec:
  selector: {app: web, tier: frontend}
`,
			wantRelation: "selector",
			matches:      labels.Set{"app": "web", "tier": "frontend", "pod-template-hash": "7d4b9c"},
			rejects:      labels.Set{"app": "web"},
		},
		{
			name: "service_without_selector",
			manifest: `
apiVersion: v1
kind: Service
spec:
  type: ExternalName
`,
		},
		{
			name: "disruption_budget_with_expressions",
			manifest: `
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  selector:
    matchLabels: {app: web}
    matchExpressions:
    - {key: tier, operator: In, values: [frontend, edge]}
`,
			wantRelation: "selector",
			matches:      labels.Set{"app": "web", "tier": "edge"},
			rejects:      labels.Set{"app": "web", "tier": "backend"},
		},
		{
			name: "network_policy_pod_selector",
			manifest: `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
spec:
  podSelector:
    matchLabels: {app: db}
`,
			wantRelation: "podSelector",
			matches:      labels.Set{"app": "db"},
			rejects:      labels.Set{"app": "web"},
		},
		{
			name: "network_policy_selecting_every_pod_is_not_an_edge",
			manifest: `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
spec:
  podSelector: {}
`,
		},
		{
			name: "workload_selector_is_expressed_by_ownership_instead",
			manifest: `
apiVersion: apps/v1
kind: Deployment
spec:
  selector:
    matchLabels: {app: web}
`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Extract(object(t, tc.manifest)).PodSelector
			wantSelector := tc.matches != nil
			if (got != nil) != wantSelector {
				t.Fatalf("Extract(%s).PodSelector = %v, want a selector: %t", tc.name, got, wantSelector)
			}
			if got == nil {
				return
			}
			if got.Relation != tc.wantRelation {
				t.Errorf("Extract(%s).PodSelector.Relation = %q, want %q", tc.name, got.Relation, tc.wantRelation)
			}
			if !got.Matches(tc.matches) {
				t.Errorf("Extract(%s).PodSelector.Matches(%v) = false, want true", tc.name, tc.matches)
			}
			if got.Matches(tc.rejects) {
				t.Errorf("Extract(%s).PodSelector.Matches(%v) = true, want false", tc.name, tc.rejects)
			}
		})
	}
}
