import type { CollectionConfig } from 'payload'
import { noOne, ownedByMe } from './access'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout'

export interface ApprovalOption {
  optionId: string
  kind: 'allow_once' | 'allow_always' | 'deny_once' | 'deny_always'
  label?: string
}

export interface Approval {
  id: number
  runId: number
  externalId: string
  requestedUser: number
  title: string
  detail: string
  options: ApprovalOption[]
  status: ApprovalStatus
  selectedOptionId: string | null
  createdAt: string
  updatedAt: string
}

export const Approvals: CollectionConfig = {
  slug: 'approvals',
  // The person who was asked, and nobody else. Created and settled only by
  // `app/api/approvals` and the dispatcher, both via `overrideAccess` — an
  // approval granted over the public REST API would be an approval nobody gave.
  access: {
    read: ownedByMe('requestedUser'),
    create: noOne,
    update: noOne,
    delete: noOne,
  },
  admin: { useAsTitle: 'title' },
  fields: [
    {
      name: 'runId',
      type: 'number',
      required: false,
      index: true,
      admin: { description: 'The broker run id that triggered this approval request (raw pg runs table, not a Payload collection).' },
    },
    {
      name: 'externalId',
      type: 'text',
      required: true,
      unique: true,
      admin: { description: 'ACP session/request_permission id — used to correlate with the ACP client.' },
    },
    {
      name: 'requestedUser',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      admin: { description: 'The user who can approve or deny this request.' },
    },
    {
      name: 'title',
      type: 'text',
      required: true,
    },
    {
      name: 'detail',
      type: 'textarea',
      required: false,
    },
    {
      name: 'options',
      type: 'json',
      required: true,
      defaultValue: [],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Approved', value: 'approved' },
        { label: 'Denied', value: 'denied' },
        { label: 'Timeout', value: 'timeout' },
      ],
      index: true,
    },
    {
      name: 'selectedOptionId',
      type: 'text',
      required: false,
      admin: { description: 'The optionId the user selected when answering.' },
    },
  ],
}

export default Approvals
