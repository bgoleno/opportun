// Shared resume fixtures: a base Google Doc, its registration, and an opportunity to tailor for.
import type { TestClient } from './isolation';

export const BASE_DOC_ID = 'BaseDoc_0123456789abcdef';
export const BASE_TEXT = 'Jane Doe\nSenior Engineer at Initech\nBuilt the billing platform in Go';

export async function registerBase(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/resumes',
    payload: {
      store: 'google_doc',
      docRef: `https://docs.google.com/document/d/${BASE_DOC_ID}/edit?usp=sharing`,
    },
  });
  if (res.statusCode !== 201) throw new Error(`register base: ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

export async function createOpportunity(c: TestClient, title = 'Senior Platform Engineer, Go/K8s') {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: {
      companyName: 'Acme',
      title,
      sourceKind: 'manual',
      descriptionMd: 'We need Go, Kubernetes and Terraform.',
    },
  });
  if (res.statusCode !== 201) throw new Error(`opportunity: ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}
