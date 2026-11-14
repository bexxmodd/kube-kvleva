// The kvleva command serves a read-only, live visualization of a Kubernetes
// cluster in the browser, on the local machine only.
//
// Usage:
//
//	kvleva [-config kvleva.yaml]
//
// Without a configuration file it shows the current cluster of the default
// kubeconfig at http://127.0.0.1:8080. See kvleva.example.yaml for the
// available settings.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	// Lets kubeconfigs that authenticate through OpenID Connect work, as
	// they do with kubectl.
	_ "k8s.io/client-go/plugin/pkg/client/auth/oidc"

	"github.com/bexxmodd/kube-kvleva/internal/config"
	"github.com/bexxmodd/kube-kvleva/internal/graph"
	"github.com/bexxmodd/kube-kvleva/internal/kube"
	"github.com/bexxmodd/kube-kvleva/internal/server"
	"github.com/bexxmodd/kube-kvleva/web"
)

const (
	// connectTimeout bounds the first contact with the cluster, so that a
	// wrong context fails quickly instead of hanging.
	connectTimeout = 20 * time.Second
	// shutdownTimeout bounds how long open requests may finish on exit.
	shutdownTimeout = 5 * time.Second
)

func main() {
	configPath := flag.String("config", "", "path to the YAML configuration file (optional)")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *configPath); err != nil {
		fmt.Fprintln(os.Stderr, "kvleva:", err)
		os.Exit(1)
	}
}

// run serves the web interface for the cluster selected by the
// configuration file at configPath until ctx is done.
func run(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	assets, err := web.Assets()
	if err != nil {
		return fmt.Errorf("loading the web interface: %w", err)
	}

	connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	client, err := kube.Connect(connectCtx, cfg.Cluster)
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", cfg.Listen.Addr())
	if err != nil {
		return err
	}
	// The configuration only accepts local addresses; this confirms that
	// the address actually bound is one, whatever "localhost" resolves to.
	if err := server.CheckLoopback(listener.Addr()); err != nil {
		listener.Close()
		return err
	}

	// Everything below stops when ctx is done or the server fails.
	ctx, stop := context.WithCancel(ctx)
	defer stop()

	store := graph.New()
	var background sync.WaitGroup
	background.Go(func() {
		client.Watcher(store, kube.WatcherOptions{Exclude: cfg.Resources.Exclude}).Run(ctx)
	})

	srv := &http.Server{
		Handler: server.New(server.Options{
			Cluster: client.Info,
			Store:   store,
			Events:  client,
			Assets:  assets,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		// Requests end with the app, which lets open change streams finish
		// promptly on shutdown.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	background.Go(func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			srv.Close()
		}
	})

	log.Printf("kvleva is showing cluster %q (%s, %s) at http://%s — read-only, local only. Press Ctrl+C to stop.",
		client.Info.Name, client.Info.Server, client.Info.Version, listener.Addr())
	err = srv.Serve(listener)
	// Whatever ended the server, stop the cluster watches and wait for them.
	stop()
	background.Wait()
	if !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
