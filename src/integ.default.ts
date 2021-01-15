import * as cdk from '@aws-cdk/core';
import { SeleniumGridConstruct } from './index';

const app = new cdk.App();
const env = {
  region: process.env.CDK_DEFAULT_REGION,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const stack = new cdk.Stack(app, 'testing-stack', { env });

new SeleniumGridConstruct(stack, 'SeleniumHubCluster', {
  cpu: 256,
  memory: 512,
  seleniumNodeMaxInstances: 500,
  seleniumNodeMaxSessions: 500,
});
