import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Tag, NEEDS_ACTION_STATUSES, orderTagColor } from '../src/views';

describe('order tag affordances', () => {
  it('treats Draft and Held as needing attention, and nothing else', () => {
    expect(NEEDS_ACTION_STATUSES.has('Draft')).toBe(true);
    expect(NEEDS_ACTION_STATUSES.has('Held')).toBe(true);
    for (const s of ['Submitted', 'PreSubmitted', 'PendingSubmit', 'Filled']) {
      expect(NEEDS_ACTION_STATUSES.has(s)).toBe(false);
    }
  });

  it('colours attention states violet and working orders yellow', () => {
    expect(orderTagColor('Draft')).toBe('violet');
    expect(orderTagColor('Held')).toBe('violet');
    expect(orderTagColor('Submitted')).toBe('yellow');
  });

  it('shows a submit control when one is provided', () => {
    const onSubmit = vi.fn();
    render(<Tag x={0} top={0} row={0} text="1 × $10" color="violet" onSubmit={onSubmit} onTrash={() => {}} />);
    fireEvent.click(screen.getByTitle('Transmit this order'));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('omits the submit control for a Held order, which the app cannot clear', () => {
    render(<Tag x={0} top={0} row={0} text="1 × $10 · HELD" color="violet" onTrash={() => {}} />);
    expect(screen.queryByTitle('Transmit this order')).toBeNull();
    // Cancelling is still offered.
    expect(screen.getByText('🗑️')).toBeTruthy();
  });
});
