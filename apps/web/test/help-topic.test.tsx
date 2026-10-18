// @vitest-environment jsdom
/**
 * Help opened from a window's "More" link starts at that window's topic, not the current screen's (2.7 edge window).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HelpPanel } from '../src/components/HelpPanel.js';
import { helpTopics, topicFor } from '../src/help.js';
import { tr } from '../src/i18n.js';
import { useScreenHarness } from './harness.js';

useScreenHarness();

const open = (topic?: string) =>
  render(<HelpPanel context="edit" {...(topic ? { topic } : {})} t={tr} onClose={() => undefined} onTour={() => undefined} onChecklist={() => undefined} />);

// Titles in whatever language the run is in
const title = (id: string): string => helpTopics().find((topic) => topic.id === id)?.title ?? id;

const expanded = (): string[] =>
  screen
    .getAllByRole('button', { expanded: true })
    .map((button) => button.textContent ?? '');

describe('help topic', () => {
  it('opens the edge topic first when the remote collectors window asks for it', () => {
    open('edge');
    expect(expanded()).toHaveLength(1);
    expect(expanded()[0]).toContain(title('edge'));
  });

  it('opens the current screen topic without one', () => {
    open();
    expect(expanded()[0]).toContain(title(topicFor('edit')));
  });

  it('falls back to the screen topic for an unknown topic', () => {
    open('nope');
    expect(expanded()[0]).toContain(title(topicFor('edit')));
  });
});
