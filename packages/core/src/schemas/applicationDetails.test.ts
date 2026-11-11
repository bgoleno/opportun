// What a new application draft is filled with (#411, slice 1 of
// https://github.com/bgoleno/opportun/issues/401; tl's design note issuecomment-6794002888). The
// server's tests cover loading the three sources; these pin the rule itself. Every name, address
// and link here is made up.
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_DETAIL_FIELDS,
  ApplicationDetailsSchema,
  detailValuePasses,
  PROFILE_DETAIL_KEYS,
  resolveApplicationDetails,
  type DetailSources,
} from './applicationDetails';

const EMPTY_PROFILE: DetailSources['profile'] = {
  fullName: null,
  email: null,
  phone: null,
  location: null,
  workAuth: null,
  links: [],
  applicationDetails: {},
};
const NO_ACCOUNT: DetailSources['account'] = { email: null, displayName: null };
const APP = {
  submissionId: 'sub-1',
  opportunityId: 'opp-1',
  companyName: 'Example Corp',
  reviewedAt: 1_760_000_000_000,
};
const appSource = { kind: 'application' as const, ...APP };

function resolve(over: Partial<DetailSources> = {}) {
  return resolveApplicationDetails({
    profile: EMPTY_PROFILE,
    account: NO_ACCOUNT,
    lastApplication: null,
    ...over,
  });
}
const valueOf = (r: ReturnType<typeof resolve>, key: string) => r.values.find((v) => v.key === key);

describe('the detail field list', () => {
  it('names every field once, in the order the details step shows them, with its home', () => {
    expect(APPLICATION_DETAIL_FIELDS.map((f) => [f.key, f.home])).toEqual([
      ['firstName', 'details'],
      ['lastName', 'details'],
      ['fullName', 'fullName'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['country', 'details'],
      ['location', 'location'],
      ['workAuthorization', 'workAuth'],
      ['school', 'details'],
      ['degree', 'details'],
      ['linkedinUrl', 'details'],
      ['websiteUrl', 'details'],
      ['links', 'details'],
      ['heardFrom', 'details'],
    ]);
    expect(PROFILE_DETAIL_KEYS).toEqual([
      'firstName',
      'lastName',
      'country',
      'school',
      'degree',
      'linkedinUrl',
      'websiteUrl',
      'links',
      'heardFrom',
    ]);
  });

  // #435 (slice 1 of #402): four details a form asks for, and Location read as the city.
  it('labels the new details, and Location as the city', () => {
    const label = (key: string) => APPLICATION_DETAIL_FIELDS.find((f) => f.key === key)?.label;
    expect(label('country')).toBe('Country');
    expect(label('location')).toBe('Location (city)');
    expect(label('school')).toBe('School');
    expect(label('degree')).toBe('Degree');
    expect(label('heardFrom')).toBe('How did you hear about this role?');
  });

  it('the new details are text: any one line or more passes, within 2,000 characters', () => {
    for (const key of ['country', 'school', 'degree', 'heardFrom']) {
      expect(detailValuePasses(key, 'United States'), key).toBe(true);
      expect(detailValuePasses(key, "Bachelor's Degree\nin two lines"), key).toBe(true);
      expect(detailValuePasses(key, 'x'.repeat(2_000)), key).toBe(true);
      expect(detailValuePasses(key, 'x'.repeat(2_001)), key).toBe(false);
    }
    expect(
      ApplicationDetailsSchema.safeParse({
        country: 'United States',
        school: 'University of Example',
        degree: "Bachelor's Degree",
        heardFrom: 'LinkedIn',
      }).success,
    ).toBe(true);
    expect(ApplicationDetailsSchema.safeParse({ school: 'x'.repeat(2_001) }).success).toBe(false);
  });
});

describe('ApplicationDetailsSchema (the profile column)', () => {
  it('takes the keys whose home is the Application details, with values that pass the checks', () => {
    const ok = {
      firstName: 'Jane',
      lastName: 'Doe',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
      websiteUrl: 'https://jane.example.com',
      links: 'https://a.example, https://b.example',
    };
    expect(ApplicationDetailsSchema.parse(ok)).toEqual(ok);
  });

  it('refuses a key outside the list, or one that lives in a profile column', () => {
    expect(ApplicationDetailsSchema.safeParse({ nickname: 'J' }).success).toBe(false);
    expect(ApplicationDetailsSchema.safeParse({ phone: '555 0100' }).success).toBe(false);
  });

  it('refuses a value that fails the draft checks, or is over 2,000 characters', () => {
    expect(ApplicationDetailsSchema.safeParse({ linkedinUrl: 'linkedin.com/in/x' }).success).toBe(
      false,
    );
    expect(ApplicationDetailsSchema.safeParse({ firstName: 'a\nb' }).success).toBe(false);
    expect(ApplicationDetailsSchema.safeParse({ links: 'x'.repeat(2_001) }).success).toBe(false);
  });
});

describe('resolveApplicationDetails', () => {
  it('an empty profile, an account with nothing, and no earlier application: nothing', () => {
    expect(resolve()).toEqual({ values: [], leftOut: [] });
  });

  it('takes each field from the profile first, in the field list order', () => {
    const r = resolve({
      profile: {
        ...EMPTY_PROFILE,
        fullName: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+1 555 0100',
        location: 'Springfield',
        workAuth: 'Authorised to work in the US',
        applicationDetails: {
          firstName: 'Jane',
          lastName: 'Doe',
          websiteUrl: 'https://jane.example',
        },
      },
      account: { email: 'login@example.com', displayName: 'J. Doe' },
      lastApplication: { ...APP, fields: { phone: '+1 555 0199', firstName: 'Janet' } },
    });
    expect(r.values).toEqual([
      { key: 'firstName', value: 'Jane', source: { kind: 'profile' } },
      { key: 'lastName', value: 'Doe', source: { kind: 'profile' } },
      { key: 'fullName', value: 'Jane Doe', source: { kind: 'profile' } },
      { key: 'email', value: 'jane@example.com', source: { kind: 'profile' } },
      { key: 'phone', value: '+1 555 0100', source: { kind: 'profile' } },
      { key: 'location', value: 'Springfield', source: { kind: 'profile' } },
      {
        key: 'workAuthorization',
        value: 'Authorised to work in the US',
        source: { kind: 'profile' },
      },
      { key: 'websiteUrl', value: 'https://jane.example', source: { kind: 'profile' } },
    ]);
    expect(r.leftOut).toEqual([]);
  });

  it('then the account, for Email and Full name only', () => {
    const r = resolve({
      account: { email: 'login@example.com', displayName: 'Jane Doe' },
      lastApplication: { ...APP, fields: { email: 'old@example.com', fullName: 'Old Name' } },
    });
    expect(valueOf(r, 'email')).toEqual({
      key: 'email',
      value: 'login@example.com',
      source: { kind: 'account' },
    });
    expect(valueOf(r, 'fullName')).toEqual({
      key: 'fullName',
      value: 'Jane Doe',
      source: { kind: 'account' },
    });
  });

  it('then the last reviewed application, for every field the first two left empty', () => {
    const r = resolve({
      profile: { ...EMPTY_PROFILE, phone: '+1 555 0100' },
      lastApplication: {
        ...APP,
        fields: {
          firstName: 'Jane',
          phone: '+1 555 0199',
          workAuthorization: 'Citizen',
          websiteUrl: 'https://jane.example',
          custom_question: 'not a detail field',
        },
      },
    });
    expect(r.values).toEqual([
      { key: 'firstName', value: 'Jane', source: appSource },
      { key: 'phone', value: '+1 555 0100', source: { kind: 'profile' } },
      { key: 'workAuthorization', value: 'Citizen', source: appSource },
      { key: 'websiteUrl', value: 'https://jane.example', source: appSource },
    ]);
  });

  it('an empty or blank value is not a value: the next source decides', () => {
    const r = resolve({
      profile: { ...EMPTY_PROFILE, phone: '  ' },
      account: { email: 'login@example.com', displayName: '' },
      lastApplication: { ...APP, fields: { phone: '+1 555 0199', fullName: ' ' } },
    });
    expect(valueOf(r, 'phone')?.source).toEqual(appSource);
    expect(valueOf(r, 'fullName')).toBeUndefined();
  });

  it('a value that fails the checks is left out, named with its source, and not replaced', () => {
    const r = resolve({
      profile: { ...EMPTY_PROFILE, phone: 'call me maybe' },
      lastApplication: {
        ...APP,
        fields: { phone: '+1 555 0199', linkedinUrl: 'linkedin.com/in/jane', email: 'a@b.example' },
      },
    });
    // The profile holds a phone, so the profile decides; the application's phone does not
    // come back in its place (tl: no fall-through).
    expect(valueOf(r, 'phone')).toBeUndefined();
    expect(valueOf(r, 'linkedinUrl')).toBeUndefined();
    expect(r.leftOut).toEqual([
      { key: 'phone', source: { kind: 'profile' } },
      { key: 'linkedinUrl', source: appSource },
    ]);
    expect(valueOf(r, 'email')?.value).toBe('a@b.example');
  });

  it('never splits a full name into a first or last name', () => {
    const r = resolve({
      profile: { ...EMPTY_PROFILE, fullName: 'Jane Doe' },
      account: { email: null, displayName: 'Jane Doe' },
    });
    expect(valueOf(r, 'firstName')).toBeUndefined();
    expect(valueOf(r, 'lastName')).toBeUndefined();
  });

  describe('LinkedIn profile from the profile links', () => {
    const link = (url: string, label = 'Link') => ({ label, url });

    it('none: nothing from the links, the application may still fill it', () => {
      const r = resolve({
        profile: { ...EMPTY_PROFILE, links: [link('https://github.com/jane')] },
        lastApplication: { ...APP, fields: { linkedinUrl: 'https://linkedin.com/in/jane-old' } },
      });
      expect(valueOf(r, 'linkedinUrl')).toEqual({
        key: 'linkedinUrl',
        value: 'https://linkedin.com/in/jane-old',
        source: appSource,
      });
    });

    it('exactly one, on linkedin.com or a subdomain: that link, from the profile', () => {
      for (const url of [
        'https://linkedin.com/in/jane',
        'https://www.linkedin.com/in/jane',
        'https://uk.linkedin.com/in/jane',
      ]) {
        const r = resolve({
          profile: { ...EMPTY_PROFILE, links: [link('https://github.com/jane'), link(url)] },
        });
        expect(valueOf(r, 'linkedinUrl')).toEqual({
          key: 'linkedinUrl',
          value: url,
          source: { kind: 'profile' },
        });
      }
    });

    it('two: none of them is chosen', () => {
      const r = resolve({
        profile: {
          ...EMPTY_PROFILE,
          links: [link('https://linkedin.com/in/jane'), link('https://www.linkedin.com/in/j2')],
        },
      });
      expect(valueOf(r, 'linkedinUrl')).toBeUndefined();
    });

    it('a host that only looks like it is not LinkedIn', () => {
      const r = resolve({
        profile: {
          ...EMPTY_PROFILE,
          links: [link('https://notlinkedin.com/in/jane'), link('https://linkedin.com.example/x')],
        },
      });
      expect(valueOf(r, 'linkedinUrl')).toBeUndefined();
    });

    // tl on #415: a link the profile only lists is not a value the user saved, so one that
    // fails the LinkedIn check leaves the field to the next source.
    it('one that fails the LinkedIn check is not held: the next source decides', () => {
      const r = resolve({
        profile: { ...EMPTY_PROFILE, links: [link('https://jane@linkedin.com/in/jane')] },
        lastApplication: { ...APP, fields: { linkedinUrl: 'https://linkedin.com/in/jane-old' } },
      });
      expect(valueOf(r, 'linkedinUrl')).toEqual({
        key: 'linkedinUrl',
        value: 'https://linkedin.com/in/jane-old',
        source: appSource,
      });
      expect(r.leftOut).toEqual([]);
    });

    it('a saved LinkedIn detail that fails is left out, and nothing comes in its place', () => {
      const r = resolve({
        profile: {
          ...EMPTY_PROFILE,
          links: [link('https://linkedin.com/in/from-links')],
          applicationDetails: { linkedinUrl: 'linkedin.com/in/saved' },
        },
        lastApplication: { ...APP, fields: { linkedinUrl: 'https://linkedin.com/in/jane-old' } },
      });
      expect(valueOf(r, 'linkedinUrl')).toBeUndefined();
      expect(r.leftOut).toEqual([{ key: 'linkedinUrl', source: { kind: 'profile' } }]);
    });

    it('a saved LinkedIn detail wins over the links', () => {
      const r = resolve({
        profile: {
          ...EMPTY_PROFILE,
          links: [link('https://linkedin.com/in/from-links')],
          applicationDetails: { linkedinUrl: 'https://linkedin.com/in/saved' },
        },
      });
      expect(valueOf(r, 'linkedinUrl')?.value).toBe('https://linkedin.com/in/saved');
    });
  });

  describe('Links from the profile links', () => {
    it("the links' addresses as text, in order, joined with a comma", () => {
      const r = resolve({
        profile: {
          ...EMPTY_PROFILE,
          links: [
            { label: 'GitHub', url: 'https://github.com/jane' },
            { label: 'Blog', url: 'https://jane.example/blog' },
          ],
        },
      });
      expect(valueOf(r, 'links')).toEqual({
        key: 'links',
        value: 'https://github.com/jane, https://jane.example/blog',
        source: { kind: 'profile' },
      });
    });

    it('stops before 2,000 characters', () => {
      const long = (i: number) => ({
        label: `L${i}`,
        url: `https://example.com/${'x'.repeat(470)}${i}`,
      });
      const r = resolve({ profile: { ...EMPTY_PROFILE, links: [0, 1, 2, 3, 4].map(long) } });
      const value = valueOf(r, 'links')?.value ?? '';
      expect(value.length).toBeLessThanOrEqual(2_000);
      expect(value.split(', ')).toHaveLength(4);
    });

    it('a saved Links detail wins over the profile links', () => {
      const r = resolve({
        profile: {
          ...EMPTY_PROFILE,
          links: [{ label: 'GitHub', url: 'https://github.com/jane' }],
          applicationDetails: { links: 'My own text' },
        },
      });
      expect(valueOf(r, 'links')?.value).toBe('My own text');
    });
  });

  it('never guesses Website from the links', () => {
    const r = resolve({
      profile: { ...EMPTY_PROFILE, links: [{ label: 'Website', url: 'https://jane.example' }] },
    });
    expect(valueOf(r, 'websiteUrl')).toBeUndefined();
  });
});
