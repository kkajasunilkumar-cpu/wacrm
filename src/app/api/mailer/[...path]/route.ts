import { NextRequest, NextResponse } from 'next/server'

const MAILER_URL = 'http://localhost:3003'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  const pathStr = path.join('/')
  const res = await fetch(`${MAILER_URL}/${pathStr}`)
  const data = await res.json()
  return NextResponse.json(data)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  const pathStr = path.join('/')
  const body = await request.json().catch(() => ({}))
  const res = await fetch(`${MAILER_URL}/${pathStr}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return NextResponse.json(data)
}
