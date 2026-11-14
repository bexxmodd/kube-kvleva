Feature: Resource relationships
  As a cluster operator
  I want related resources shown inside each other or connected by arrows
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
    And an arrow connects the pod to the node

  Scenario: A resource whose owner is unknown stays at the top level
    Given a pod whose owner no longer exists
    When the namespace is displayed
    Then the pod is at the top level

  Rule: A resource that references another is connected to it by an arrow

  Scenario: A route is connected to its gateway
    Given a gateway
    And an http route that names the gateway as its parent
    When the resources are displayed
    Then an arrow connects the http route to the gateway

  Scenario Outline: Well-known references are connected
    Given a <source> that refers to a <target> by <means>
    When the resources are displayed
    Then an arrow connects the <source> to the <target>

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

  Scenario: A custom resource reference is connected
    Given a custom resource that refers to a secret through a field ending in "Ref"
    When the resources are displayed
    Then an arrow connects the custom resource to the secret

  Scenario: A reference into another namespace is connected
    Given an http route in one namespace that names a gateway in another namespace as its parent
    When the resources are displayed
    Then an arrow connects the http route to the gateway

  Scenario: A reference to something that does not exist is reported, not drawn
    Given an http route with a backend reference to a service that does not exist
    When the http route's details are displayed
    Then the missing service is listed as a missing reference

  Rule: Arrows stay visible when an endpoint is folded away

  Scenario: An arrow to a folded resource ends at its nearest visible container
    Given a service that selects a pod inside a collapsed deployment
    When the resources are displayed
    Then an arrow connects the service to the deployment
