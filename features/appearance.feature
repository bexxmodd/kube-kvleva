Feature: Appearance
  As someone who keeps the cluster picture open for long stretches,
  I want text that is comfortable to read and a theme that suits the room I am in,
  so that looking at the cluster is not tiring.

  Rule: The interface comes in a night theme and a day theme

  Scenario: The night theme is the default
    Given the app is opened for the first time
    Then the interface is shown in the night theme
    And a button offers to switch to the day theme

  Scenario: Switching to the day theme
    Given the interface is shown in the night theme
    When the theme button is used
    Then the interface is shown in the day theme
    And the button now offers to switch back to the night theme

  Scenario: Switching the theme does not disturb the cluster picture
    Given a cluster is displayed with some resources opened
    When the theme is switched
    Then the same resources stay opened
    And nothing is requested from the cluster again

  Scenario: The chosen theme is remembered
    Given the day theme was chosen
    When the page is opened again
    Then the interface is shown in the day theme from the first moment
    And the night theme is never flashed before it

  Scenario Outline: Health stays readable in both themes
    Given the interface is shown in the <theme> theme
    Then green, yellow and red resources are clearly distinguishable from their background
    And text is clearly readable on every surface

    Examples:
      | theme |
      | night |
      | day   |

  Rule: Text looks the same on every machine

  Scenario: The typeface ships with the app
    Given a machine that has none of the app's fonts installed
    When the app is opened
    Then text is set in the app's own typeface
    And nothing is fetched from outside the app

  Scenario: Text is comfortably sized
    When the app is opened
    Then ordinary text is slightly larger than the browser's small print
    And no text is too small to read
