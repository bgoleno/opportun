// Greenhouse job board adapter (FR-D1): the discovery source for an `ats_greenhouse` board. Its
// listing, mapping and job check are the Greenhouse site module's (sites/greenhouse.ts, #769).
import { GREENHOUSE_API_HOST } from '@opportun/core';
import { greenhouseModule } from '../../sites/greenhouse';
import { registerBuiltinSource, type DiscoverySource } from '../discoverySource';

// Kept for jobs/atsDetect.ts until its Greenhouse probe moves to the site module (#769 step 2,
// after https://github.com/bgoleno/opportun/pull/842 moves atsDetect to lib/).
export const GREENHOUSE_HOST = GREENHOUSE_API_HOST;

export const greenhouseSource: DiscoverySource = {
  kind: 'ats_greenhouse',
  fetchPostings: greenhouseModule.api!.listBoard!,
};

registerBuiltinSource(greenhouseSource);
