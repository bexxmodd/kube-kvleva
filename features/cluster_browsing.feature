Feature: Browsing the cluster
  As a cluster operator
  I want to explore every resource of my cluster in the browser
  So that I can find and inspect what I care about, even in a very large cluster

  Background:
    Given the app is connected to a cluster

  Rule: Every resource of the cluster is available

  Scenario: Built-in and custom resources are both loaded
    Given the cluster has deployments and a custom resource type with instances
    When the cluster is displayed
    Then the deployments are available
    And the custom resource instances are available

  Scenario: A custom resource type added later is picked up
    Given the cluster is displayed
    When a new custom resource type is installed and an instance is created
    Then the new instance becomes available without restarting the app

  Scenario: The cluster summary reports health totals
    Given the cluster has healthy, in-progress, and failed resources
    When the cluster summary is displayed
    Then it reports how many resources are green, yellow, and red
    And it reports the same breakdown for every namespace

  Rule: Resources are arranged logically

  Scenario: Resources are grouped by namespace and ordered by role
    Given a namespace with a gateway, a service, a deployment, and a config map
    When the namespace is displayed
    Then the resources appear in the order gateway, service, deployment, config map

  Scenario: Cluster-wide resources are shown apart from namespaces
    Given the cluster has nodes, storage classes, and namespaces
    When the cluster is displayed
    Then nodes have their own area
    And other cluster-wide resources are shown in a cluster-wide area

  Rule: Large clusters stay usable

  Scenario: A long list is delivered in pages
    Given a namespace with 250 top-level resources
    When the first page of the namespace is requested
    Then 100 resources are returned
    And the total of 250 is reported

  Scenario: Nested resources are only loaded on demand
    Given a deployment with many pods
    When the namespace is displayed
    Then the deployment reports how many resources it contains and their health
    But its pods are not delivered until the deployment is opened

  Scenario: A node can be opened to explore the pods running on it
    Given a node with pods scheduled on it
    When the node is opened
    Then the pods running on that node are listed with their containers

  Rule: Filters narrow what is shown

  Scenario: A resource type can be filtered out
    Given a namespace with deployments and config maps
    When config maps are filtered out
    Then only the deployments are listed

  Scenario: Filtering out an intermediate type keeps its contents reachable
    Given a deployment that owns a replica set that owns a pod
    When replica sets are filtered out
    Then the pod appears directly inside the deployment

  Scenario: Filtering by health keeps the path to failing resources
    Given a healthy-looking deployment that contains a failed pod
    And another deployment whose resources are all healthy
    When only failed resources are requested
    Then the first deployment is listed because it contains the failed pod
    And the second deployment is not listed

  Scenario: Searching by name
    Given resources named "checkout-api" and "billing-worker"
    When the search text is "CHECK"
    Then only "checkout-api" is listed

  Rule: The view follows the cluster

  Scenario: A change in the cluster is announced to the browser
    Given a browser is showing the cluster
    When a pod changes in the cluster
    Then the browser is told that the pod changed

  Scenario: A burst of changes is announced as one refresh
    Given a browser is showing the cluster
    When thousands of resources change at once
    Then the browser is told to refresh what it shows instead of receiving every change
