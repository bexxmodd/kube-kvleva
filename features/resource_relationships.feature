Feature: Resource relationships
  As a cluster operator
  I want related resources shown inside each other and their references listed
  So that I can understand how the pieces of my cluster fit together

  Rule: A resource is displayed inside the resource that owns it

  Scenario: Containers are displayed inside their pod
    Given a pod that runs two containers
    When the pod is displayed
    Then both containers appear inside the pod

  Scenario: A rollout is displayed as nested workloads
    Given a deployment that owns a replica set that owns a pod
    When the namespace is displayed
    Then the deployment is at the top level
    And the replica set appears inside the deployment
    And the pod appears inside the replica set

  Scenario: A resource owned from outside its namespace stays at the top level
    Given a pod in a namespace that is owned by a node
    When the namespace is displayed
    Then the pod is at the top level
    And the pod's details list the node as a reference

  Scenario: A resource whose owner is unknown stays at the top level
    Given a pod whose owner no longer exists
    When the namespace is displayed
    Then the pod is at the top level

  Rule: The details of a resource list what it refers to and what refers to it

  Scenario: A route lists its gateway
    Given a gateway
    And an http route that names the gateway as its parent
    When the http route's details are displayed
    Then the gateway is listed as a reference
    And the gateway's details list the http route as referring to it

  Scenario Outline: Well-known references are listed
    Given a <source> that refers to a <target> by <means>
    When the details of the <source> are displayed
    Then the <target> is listed as a reference

    Examples:
      | source                  | target                  | means                       |
      | gateway                 | gateway class           | its class name              |
      | http route              | service                 | a backend reference         |
      | ingress                 | service                 | a backend                   |
      | pod                     | node                    | its node name               |
      | pod                     | config map              | a mounted volume            |
      | pod                     | secret                  | an environment variable     |
      | pod                     | service account         | its service account name    |
      | pod                     | persistent volume claim | a mounted volume            |
      | persistent volume claim | persistent volume       | its volume name             |
      | persistent volume claim | storage class           | its storage class name      |
      | autoscaler              | deployment              | its scale target            |
      | role binding            | role                    | its role reference          |
      | role binding            | service account         | a subject                   |
      | service                 | pod                     | its label selector          |

  Scenario: A custom resource reference is listed
    Given a custom resource that refers to a secret through a field ending in "Ref"
    When the custom resource's details are displayed
    Then the secret is listed as a reference

  Scenario: A reference into another namespace is listed
    Given an http route in one namespace that names a gateway in another namespace as its parent
    When the http route's details are displayed
    Then the gateway is listed as a reference

  Scenario: A reference to something that does not exist is reported as missing
    Given an http route with a backend reference to a service that does not exist
    When the http route's details are displayed
    Then the missing service is listed as a missing reference

  Scenario: Following a reference shows the referenced resource
    Given a service that selects a pod inside a collapsed deployment
    When the pod is chosen from the service's references
    Then the pod's details are displayed
    And the deployment is opened so that the pod is shown

  Rule: References are not drawn on the cluster picture

  Scenario: The cluster picture shows no arrows
    Given an http route that names a gateway as its parent
    When the namespace is displayed
    Then no line or arrow is drawn between the http route and the gateway
