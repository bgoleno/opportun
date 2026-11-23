// Which service holds each resume store (#771, docs/architecture.md 6.3): the one place a
// resume's store is turned into the DocumentStore that reads and writes it. Each row keeps its
// own store, so changing the preference for new resumes never strands existing ones.
import type { ResumeStore } from '@opportun/core';

/**
 * How the caller reaches each store's service: the app (routes), a job's services (jobs) or the
 * importer's dependencies. Each is asked only when its store is the one wanted.
 */
export interface ResumeStoreLookup<T> {
  documentStore: () => T;
  reactiveResumeStore: () => T;
  localFileStore: () => T;
}

/** The store that holds `store`'s resumes. */
export function resumeStoreFor<T>(store: ResumeStore, stores: ResumeStoreLookup<T>): T {
  switch (store) {
    case 'google_doc':
      return stores.documentStore();
    case 'reactive_resume':
      return stores.reactiveResumeStore();
    case 'local_file':
      return stores.localFileStore();
  }
}
