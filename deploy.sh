#!/bin/bash
# ============================================================
# deploy.sh — One-command deploy for Agent Builder
# ============================================================
# Usage:
#   ./deploy.sh "description of changes"
#
# What it does:
#   1. Deploys Supabase Edge Functions (backend)
#   2. Pushes code to Google Apps Script
#   3. Creates a new Apps Script version
#   4. Commits and pushes to GitHub
#   5. Reminds you to update the version in GCP Marketplace
# ============================================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

DESCRIPTION="${1:-Update}"

echo ""
echo -e "${BLUE}🚀 Agent Builder — Full Deploy${NC}"
echo -e "${BLUE}================================${NC}"
echo -e "Description: ${DESCRIPTION}"
echo ""

# ---- Step 1: Deploy Supabase Edge Functions ----
echo -e "${YELLOW}[1/5] Deploying Supabase Edge Functions...${NC}"
supabase functions deploy agent-run --no-verify-jwt 2>&1 | tail -2
supabase functions deploy agent-status --no-verify-jwt 2>&1 | tail -2
supabase functions deploy agent-crud --no-verify-jwt 2>&1 | tail -2
echo -e "${GREEN}  ✓ Edge functions deployed${NC}"

# ---- Step 2: Push to Apps Script ----
echo ""
echo -e "${YELLOW}[2/5] Pushing to Google Apps Script...${NC}"
cd apps-script
clasp push --force 2>&1 | tail -1
echo -e "${GREEN}  ✓ Apps Script updated${NC}"

# ---- Step 3: Create new Apps Script version ----
echo ""
echo -e "${YELLOW}[3/5] Creating new Apps Script version...${NC}"
VERSION_OUTPUT=$(clasp version "$DESCRIPTION" 2>&1)
echo "  $VERSION_OUTPUT"
VERSION_NUM=$(echo "$VERSION_OUTPUT" | grep -oE '[0-9]+' | head -1)
echo -e "${GREEN}  ✓ Version ${VERSION_NUM} created${NC}"
cd ..

# ---- Step 4: Git commit & push ----
echo ""
echo -e "${YELLOW}[4/5] Committing to GitHub...${NC}"
git add -A
git commit -m "$DESCRIPTION" 2>&1 | tail -1
git push 2>&1 | tail -2
echo -e "${GREEN}  ✓ Pushed to GitHub${NC}"

# ---- Step 5: Reminder ----
echo ""
echo -e "${YELLOW}[5/5] GCP Marketplace Update${NC}"
echo -e "${RED}  ⚠️  Go to GCP Console → Marketplace SDK → App Configuration${NC}"
echo -e "${RED}     Update 'Sheets add-on script version' to: ${VERSION_NUM}${NC}"
echo -e "${RED}     Then click Save.${NC}"
echo ""
echo -e "  Direct link: https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com/googleApps_overview"
echo ""
echo -e "${GREEN}🎉 Deploy complete!${NC}"
echo ""
