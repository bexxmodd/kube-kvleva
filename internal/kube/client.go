package kube

import (
	"context"
	"encoding/json"
	"fmt"

	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/bexxmodd/kube-kvleva/internal/config"
	"github.com/bexxmodd/kube-kvleva/internal/graph"
)

const (
	userAgent = "kvleva"
	// Loading a cluster means one list and one watch per resource type, so
	// the client-side rate limit is raised well above the default of 5.
	queriesPerSecond = 50
	burst            = 100
)

// Info describes the cluster kvleva is connected to.
type Info struct {
	// Name is the kubeconfig context.
	Name    string `json:"name"`
	Server  string `json:"server"`
	Version string `json:"version"`
}

// Client is a read-only connection to a cluster.
type Client struct {
	Info Info

	discovery discovery.DiscoveryInterface
	dynamic   dynamic.Interface
}

// RESTConfig returns the connection settings for the cluster selected by
// cluster, together with the name of the kubeconfig context that was used.
// The returned settings only permit read requests.
func RESTConfig(cluster config.Cluster) (*rest.Config, string, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if cluster.Kubeconfig != "" {
		rules.ExplicitPath = cluster.Kubeconfig
	}
	overrides := &clientcmd.ConfigOverrides{CurrentContext: cluster.Context}
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)

	raw, err := loader.RawConfig()
	if err != nil {
		return nil, "", fmt.Errorf("loading kubeconfig: %w", err)
	}
	contextName := cluster.Context
	if contextName == "" {
		contextName = raw.CurrentContext
	}
	if _, ok := raw.Contexts[contextName]; !ok {
		return nil, "", fmt.Errorf("kubeconfig has no context %q", contextName)
	}
	restConfig, err := loader.ClientConfig()
	if err != nil {
		return nil, "", fmt.Errorf("kubeconfig context %q: %w", contextName, err)
	}
	restConfig.Wrap(ReadOnly)
	restConfig.UserAgent = userAgent
	restConfig.QPS = queriesPerSecond
	restConfig.Burst = burst
	return restConfig, contextName, nil
}

// Connect opens a read-only connection to the cluster selected by cluster
// and verifies that the cluster answers.
func Connect(ctx context.Context, cluster config.Cluster) (*Client, error) {
	restConfig, contextName, err := RESTConfig(cluster)
	if err != nil {
		return nil, err
	}
	discoveryClient, err := discovery.NewDiscoveryClientForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("cluster %q: %w", contextName, err)
	}
	dynamicClient, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("cluster %q: %w", contextName, err)
	}
	body, err := discoveryClient.RESTClient().Get().AbsPath("/version").Do(ctx).Raw()
	if err != nil {
		return nil, fmt.Errorf("connecting to cluster %q at %s: %w", contextName, restConfig.Host, err)
	}
	var serverVersion version.Info
	if err := json.Unmarshal(body, &serverVersion); err != nil {
		return nil, fmt.Errorf("cluster %q at %s sent an unreadable version: %w", contextName, restConfig.Host, err)
	}
	return &Client{
		Info:      Info{Name: contextName, Server: restConfig.Host, Version: serverVersion.GitVersion},
		discovery: discoveryClient,
		dynamic:   dynamicClient,
	}, nil
}

// Watcher returns a Watcher that keeps store in step with the cluster.
func (c *Client) Watcher(store *graph.Store, opts WatcherOptions) *Watcher {
	return NewWatcher(c.discovery, c.dynamic, store, opts)
}

// Events returns the Kubernetes Events about the resource with the given
// uid, newest first. namespace is the namespace of the resource, or "" for
// a cluster-scoped resource.
func (c *Client) Events(ctx context.Context, namespace, uid string) ([]Event, error) {
	return ListEvents(ctx, c.dynamic, namespace, uid)
}
