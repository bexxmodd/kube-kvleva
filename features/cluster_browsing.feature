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

  Rule: Resource types are listed by API group, and a group can be expanded

    The list starts as the API groups alone, so that a cluster with many of
    them stays easy to survey; the resource types of a group are one click away.

  Scenario: API groups start collapsed
    Given a cluster with pods, services and deployments
    When the list of resource types is displayed for the first time
    Then the "core" and "apps" groups are listed, each with its number of resources
    But no resource type is listed under them yet

  Scenario: Expanding an API group lists its resource types
    Given the list of resource types is displayed
    When the "core" group is expanded
    Then pods and services are listed under "core"
    But the "apps" group stays collapsed

  Scenario: An expanded API group can be collapsed again
    Given the "apps" group is expanded
    When the "apps" group is collapsed
    Then the resource types of "apps" are no longer listed
    But the "apps" group itself stays listed with its number of resources

  Scenario: Expanding or collapsing an API group filters nothing
    Given a cluster with deployments
    When the "apps" group is expanded and collapsed again
    Then the deployments are shown in the cluster picture throughout

  Scenario: A collapsed API group can still be filtered out as a whole
    Given the "apps" group is collapsed
    When the "apps" group is filtered out
    Then no resource of an "apps" type is listed in the cluster picture

  Scenario: Looking for a resource type finds it in a collapsed group
    Given the "apps" group is collapsed
    When the list of resource types is narrowed to "deploy"
    Then "Deployment" is listed under "apps"

  Scenario: Expanded API groups are remembered
    Given the "apps" group was expanded
    When the page is opened again
    Then the "apps" group is still expanded
    And the other groups are still collapsed

  Rule: System resources stay out of the way unless asked for

    System resources are what a cluster brings along rather than what its
    users deploy: everything in the system namespaces, what Kubernetes
    maintains by itself, and what was installed while the cluster was created.

  Scenario: System resources are hidden by default
    Given a freshly created cluster with one application deployed by its user
    When the cluster is displayed
    Then the application is shown
    And the cluster's own namespaces and built-in resources are not shown
    And the number of hidden system resources is reported

  Scenario: The system resources switch shows everything
    Given a freshly created cluster with one application deployed by its user
    When system resources are switched on
    Then the cluster's own namespaces and built-in resources are shown as well

  Scenario: Totals follow the switch
    Given a cluster whose only failing resource is a system resource
    When the cluster summary is displayed with system resources switched off
    Then no failing resource is counted
    But the failing resource is counted once system resources are switched on

  Scenario Outline: What counts as a system resource
    Given <resource>
    When the cluster is displayed with system resources switched off
    Then the resource is <shown or hidden>

    Examples:
      | resource                                                         | shown or hidden |
      | a workload in the "kube-system" namespace                        | hidden          |
      | the "kube-system" namespace itself                               | hidden          |
      | a built-in access role maintained by Kubernetes                  | hidden          |
      | a cluster-wide resource installed while the cluster was created  | hidden          |
      | the certificate bundle Kubernetes adds to every namespace        | hidden          |
      | a node                                                           | shown           |
      | the "default" namespace                                          | shown           |
      | a workload its user deployed to the "default" namespace          | shown           |
      | a namespace its user created right after the cluster was created | shown           |
      | a cluster-wide resource its user created later                   | shown           |

  Scenario: A system resource can still be inspected through a reference
    Given a user's pod that mounts the certificate bundle of its namespace
    And system resources are switched off
    When the certificate bundle is chosen from the pod's references
    Then the certificate bundle's details are displayed

  Rule: The filters panel can be resized

  Scenario: Dragging the dividing line changes the width of the filters panel
    Given the cluster is displayed
    When the line between the filters panel and the cluster picture is dragged to the right
    Then the filters panel becomes wider

  Scenario: The filters panel never takes more than a third of the window
    Given the cluster is displayed
    When the dividing line is dragged far to the right
    Then the filters panel stops at one third of the window width

  Scenario: The filters panel does not collapse
    Given the cluster is displayed
    When the dividing line is dragged all the way to the left
    Then the filters panel keeps a minimum width

  Scenario: The chosen width is remembered
    Given the filters panel was resized
    When the page is opened again
    Then the filters panel has the chosen width

  Rule: The filters panel can be hidden

  Scenario: Hiding the filters panel gives its room to the cluster picture
    Given the cluster is displayed
    When the filters panel is hidden
    Then the filters panel and its dividing line are no longer shown
    And the control to show it again stays available

  Scenario: Showing the filters panel again brings it back as it was
    Given the filters panel was resized and then hidden
    When the filters panel is shown again
    Then the filters panel has the width it had before

  Scenario: Filters keep applying while the panel is hidden
    Given config maps are filtered out
    When the filters panel is hidden
    Then config maps are still not listed

  Scenario: Whether the panel is hidden is remembered
    Given the filters panel was hidden
    When the page is opened again
    Then the filters panel is still hidden

  Rule: The view follows the cluster

  Scenario: A change in the cluster is announced to the browser
    Given a browser is showing the cluster
    When a pod changes in the cluster
    Then the browser is told that the pod changed

  Scenario: A burst of changes is announced as one refresh
    Given a browser is showing the cluster
    When thousands of resources change at once
    Then the browser is told to refresh what it shows instead of receiving every change
