// Package config loads and validates the kvleva configuration file.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"

	"sigs.k8s.io/yaml"
)

// ErrNotLoopback reports a listen address that is reachable from other
// machines. kvleva only ever serves the local machine.
var ErrNotLoopback = errors.New("only local (loopback) listen addresses are allowed")

// Config is the complete kvleva configuration.
type Config struct {
	Cluster   Cluster   `json:"cluster"`
	Listen    Listen    `json:"listen"`
	Resources Resources `json:"resources"`
	Logs      Logs      `json:"logs"`
}

// Cluster selects the Kubernetes cluster to visualize.
type Cluster struct {
	// Kubeconfig is the path of the kubeconfig file. When empty, the standard
	// lookup applies ($KUBECONFIG, then ~/.kube/config).
	Kubeconfig string `json:"kubeconfig"`
	// Context is the kubeconfig context to use. When empty, the kubeconfig's
	// current context is used.
	Context string `json:"context"`
}

// Listen is the local address the web interface is served on.
type Listen struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
}

// Addr returns the address in the host:port form expected by net.Listen.
func (l Listen) Addr() string {
	return net.JoinHostPort(l.Address, strconv.Itoa(l.Port))
}

// Resources tunes which resource types are loaded from the cluster.
type Resources struct {
	// Exclude lists resource types that are not loaded, named like kubectl
	// does: "<resource>" for the core group and "<resource>.<group>"
	// otherwise, for example "secrets" or "leases.coordination.k8s.io".
	// Setting it replaces the default list.
	Exclude []string `json:"exclude"`
}

// Logs controls whether container logs can be viewed.
type Logs struct {
	// Enabled says whether the web interface offers live container logs.
	// Logs hold whatever the applications print, which can include
	// credentials, so they can be switched off.
	Enabled bool `json:"enabled"`
}

// Default returns the configuration used when no file is given: serve on
// localhost, leave out resource types that only add noise, and offer logs.
func Default() Config {
	return Config{
		Listen: Listen{Address: "127.0.0.1", Port: 8080},
		Resources: Resources{Exclude: []string{
			"events",
			"events.events.k8s.io",
			"leases.coordination.k8s.io",
			"endpoints",
		}},
		Logs: Logs{Enabled: true},
	}
}

// Load reads and validates the configuration file at path. An empty path
// yields Default.
func Load(path string) (Config, error) {
	if path == "" {
		return Default(), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("reading configuration: %w", err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return Config{}, fmt.Errorf("configuration %s: %w", path, err)
	}
	return cfg, nil
}

// Parse decodes a YAML configuration document on top of Default and validates
// it. Unknown settings are errors so that typos do not go unnoticed.
func Parse(data []byte) (Config, error) {
	cfg := Default()
	if err := yaml.UnmarshalStrict(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parsing: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if !isLoopback(c.Listen.Address) {
		return fmt.Errorf("listen.address %q: %w", c.Listen.Address, ErrNotLoopback)
	}
	if c.Listen.Port < 1 || c.Listen.Port > 65535 {
		return fmt.Errorf("listen.port %d: must be between 1 and 65535", c.Listen.Port)
	}
	return nil
}

func isLoopback(address string) bool {
	if address == "localhost" {
		return true
	}
	ip := net.ParseIP(address)
	return ip != nil && ip.IsLoopback()
}
