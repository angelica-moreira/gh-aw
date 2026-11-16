import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { entitiesOfType, jsonLdEntities, type JsonLdEntity } from './helpers/json-ld';

async function loadEntities(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return jsonLdEntities(page);
}

function onlyEntity(entities: JsonLdEntity[], type: string): JsonLdEntity {
  const matches = entitiesOfType(entities, type);
  expect(matches, `${type} entities`).toHaveLength(1);
  return matches[0];
}

test.describe('Schema JSON-LD', () => {
  test('keeps homepage website schema intact', async ({ page }) => {
    const entities = await loadEntities(page, '/gh-aw/');

    const website = onlyEntity(entities, 'WebSite');
    const organization = onlyEntity(entities, 'Organization');
    onlyEntity(entities, 'FAQPage');

    expect(website.name).toBe('gh-aw — GitHub Agentic Workflows');
    expect(website.url).toBe('https://github.github.com/gh-aw/');
    expect(organization.name).toBe('GitHub');
    expect(organization.url).toBe('https://github.com/github/gh-aw');
    expect(organization.logo).toBe(
      'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'
    );
    expect(organization.sameAs).toEqual(
      expect.arrayContaining(['https://github.com/github/gh-aw'])
    );
  });

  test('blog posts carry a single BlogPosting from starlight-blog', async ({ page }) => {
    const postUrl = 'https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-testing-validation/';
    const entities = await loadEntities(page, '/gh-aw/blog/2026-01-13-meet-the-workflows-testing-validation/');

    const post = onlyEntity(entities, 'BlogPosting');
    expect(post.headline).toBe('Meet the Workflows: Testing & Validation');
    expect(post.description, 'non-empty string description').toMatch(/\S/);
    expect(post.url).toBe(postUrl);
    expect(post.mainEntityOfPage).toBe(postUrl);
    expect(post.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(post.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(post.publisher).toEqual({ '@id': 'https://github.github.com/gh-aw/#organization' });
    expect(post.isPartOf).toMatchObject({ '@type': 'Blog', url: 'https://github.github.com/gh-aw/blog/' });
    expect(post.author).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ '@type': 'Person', name: 'Don Syme' }),
      ])
    );
    onlyEntity(entities, 'BreadcrumbList');
    expect(entitiesOfType(entities, 'TechArticle')).toHaveLength(0);
  });

  test('adds TechArticle schema to inner docs pages', async ({ page }) => {
    const entities = await loadEntities(page, '/gh-aw/setup/quick-start/');

    const article = onlyEntity(entities, 'TechArticle');
    expect(article.headline).toBe('GitHub Agentic Workflows Quickstart');
    expect(article.description).toBe(
      'Install GitHub Agentic Workflows (gh-aw), choose an AI engine, add a Markdown workflow, and run an AI agent through GitHub Actions.'
    );
    expect(article.url).toBe('https://github.github.com/gh-aw/setup/quick-start/');
    expect(article.isPartOf).toEqual({
      '@id': 'https://github.github.com/gh-aw/#website',
    });
    // The page's own HowTo (in its frontmatter head) is intentional.
    onlyEntity(entities, 'HowTo');
  });
});
