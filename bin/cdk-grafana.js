#!/usr/bin/env node

const cdk = require('@aws-cdk/core');
const { CdkGrafanaStack } = require('../lib/cdk-grafana-stack');

const app = new cdk.App();
new CdkGrafanaStack(app, 'CdkGrafanaStack');
