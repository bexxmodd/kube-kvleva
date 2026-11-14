Feature: Starting the app
  As a cluster operator
  I want to start the visualizer from my terminal with a small configuration file
  So that it connects to the cluster I choose and opens on my machine

  Scenario: Starting without a configuration file uses safe defaults
    When the app is started without a configuration file
    Then it listens on the local machine only
    And it uses the current cluster of the default kubeconfig

  Scenario: The configuration file chooses the cluster
    Given a configuration file naming the cluster context "kind-kvleva"
    When the app is started with that file
    Then it connects to the "kind-kvleva" cluster

  Scenario: The configuration file chooses the local port
    Given a configuration file with port 9090
    When the app is started with that file
    Then it listens on local port 9090

  Scenario: Noisy resource types are left out by default
    When the app is started without a configuration file
    Then events and leases are not loaded as resources

  Scenario: Resource types can be excluded
    Given a configuration file that excludes secrets
    When the app is started with that file
    Then secrets are not loaded from the cluster

  Scenario: A misspelled setting is reported
    Given a configuration file with an unknown setting
    When the app is started with that file
    Then startup fails and names the unknown setting

  Scenario: An unreadable configuration file is reported
    Given a configuration file path that does not exist
    When the app is started with that file
    Then startup fails and names the missing file
