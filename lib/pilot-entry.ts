/**
 * Deployment gate for the application's root entry.
 *
 * The legacy lesson remains the local/default entry. A hosted pilot must opt
 * in explicitly so an omitted or malformed binding cannot expose the pilot
 * accidentally.
 */
export function pilotModeEnabled(value: unknown): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

export function homeRouteForPilotMode(value: unknown): '/pilot' | 'legacy' {
  return pilotModeEnabled(value) ? '/pilot' : 'legacy';
}
