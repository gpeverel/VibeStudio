import { afterEach, beforeEach, describe, it } from 'node:test';
import { registerGitBoundaryTests } from './cases/git-boundaries.ts';

registerGitBoundaryTests({ afterEach, beforeEach, describe, it });
