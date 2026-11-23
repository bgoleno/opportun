// https://github.com/bgoleno/opportun/issues/771 (docs/architecture.md 6.3): resume-store dispatch
// was repeated in routes/resumes.ts, jobs/submissionSnapshot.ts and lib/importer.ts, and one
// store had two names: `google_doc` on a resume row and `google` in the document-store
// preference. One registry (lib/resumeStores.ts) now maps each store to the service that holds
// it, and `google_doc` is the one name. A preference stored as `google`, and a client that still
// sends it, keep working.
import { RESUME_STORES } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { resumeStoreFor } from '../src/lib/resumeStores';
import { DOCUMENT_STORE_SETTING } from '../src/adapters/reactiveResume';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';

const boot = useApi();

describe('one registry for the resume stores (#771)', () => {
  it('dispatches each store to the service that holds it, asking only that one', () => {
    const served = RESUME_STORES.map((store) => {
      const asked: string[] = [];
      const ask = (service: string) => () => {
        asked.push(service);
        return service;
      };
      const got = resumeStoreFor(store, {
        documentStore: ask('documentStore'),
        reactiveResumeStore: ask('reactiveResumeStore'),
        localFileStore: ask('localFileStore'),
      });
      return { store, got, asked };
    });
    expect(served).toEqual([
      { store: 'google_doc', got: 'documentStore', asked: ['documentStore'] },
      { store: 'local_file', got: 'localFileStore', asked: ['localFileStore'] },
      { store: 'reactive_resume', got: 'reactiveResumeStore', asked: ['reactiveResumeStore'] },
    ]);
  });
});

describe('the document-store preference has one name per store (#771)', () => {
  it('a preference stored under the old name reads as google_doc', async () => {
    const { app, a } = await boot();
    await writeUserSetting(
      app.db,
      { userId: a.userId, isAdmin: false },
      DOCUMENT_STORE_SETTING,
      'google',
    );
    const res = await a.request({ method: 'GET', url: '/api/v1/settings/document-store' });
    expect(res.json()).toEqual({ store: 'google_doc' });
  });

  it('an unset preference reads as google_doc', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/settings/document-store' });
    expect(res.json()).toEqual({ store: 'google_doc' });
  });

  it.each(['google', 'google_doc'])(
    'a client that sends %s is stored as google_doc',
    async (sent) => {
      const { a } = await boot();
      const put = await a.request({
        method: 'PUT',
        url: '/api/v1/settings/document-store',
        payload: { store: sent },
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toEqual({ store: 'google_doc' });
      const res = await a.request({ method: 'GET', url: '/api/v1/settings/document-store' });
      expect(res.json()).toEqual({ store: 'google_doc' });
    },
  );
});
