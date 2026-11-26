// Build-pipeline fixture: JSX (automatic runtime) + externals that must stay `require()` calls.
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'

export const inject = ['slots']

export function apply(ctx) {
  ctx.record({
    hooks: typeof React.useState,
    portal: typeof createPortal,
    virtual: typeof useVirtualizer,
    element: <div data-x="1">{'text'}<>{'fragment'}</></div>,
  })
}
