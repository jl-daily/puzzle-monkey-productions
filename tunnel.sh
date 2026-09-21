#!/bin/bash
cd "$(dirname "$0")"
exec bun tunnel.ts
