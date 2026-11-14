Feature: Resource details
  As a cluster operator
  I want to click a resource and read its configuration and what happened to it
  So that I can understand why it is green, yellow, or red

  Scenario: Clicking a resource shows its configuration followed by its status
    Given a deployment in the cluster
    When the deployment is selected
    Then its configuration is shown as YAML
    And its status is shown after the configuration
    And the reason for its health color is shown

  Scenario: Bookkeeping noise is left out of the configuration
    Given a resource carrying field-management bookkeeping
    When the resource is selected
    Then the bookkeeping is not part of the shown configuration

  Scenario: Status updates are listed newest first
    Given a resource whose conditions changed at different times
    When the resource is selected
    Then its conditions are listed with the most recent change first

  Scenario: Conditions reported per parent are attributed
    Given an http route with conditions reported for its parent gateway
    When the http route is selected
    Then each condition names the parent it was reported for

  Scenario: Events about the resource are shown
    Given a pod with a warning event about a failing container
    When the pod is selected
    Then the warning event is listed with its reason, message, and time

  Scenario: Details still load when events are unavailable
    Given events cannot be read from the cluster
    When a resource is selected
    Then its configuration and status are shown
    And a note explains that events could not be loaded

  Scenario: Connections are listed in both directions
    Given an http route that references a gateway
    When the gateway is selected
    Then the http route is listed as referring to the gateway

  Scenario: A container can be inspected on its own
    Given a pod that runs two containers
    When one container is selected
    Then that container's configuration is shown
    And that container's current state is shown

  Scenario: Selecting something that was just deleted
    Given a resource that has been deleted from the cluster
    When the resource is selected
    Then the app reports that the resource no longer exists
