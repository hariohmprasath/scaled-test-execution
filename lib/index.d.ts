import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as cdk from '@aws-cdk/core';
export interface ISeleniumGridProps {
    readonly vpc?: ec2.IVpc;
    readonly seleniumVersion?: string;
    readonly memory?: number;
    readonly cpu?: number;
    readonly seleniumNodeMaxInstances?: number;
    readonly seleniumNodeMaxSessions?: number;
}
export interface IResourceDefinitinProps {
    cluster: ecs.Cluster;
    stack: cdk.Construct;
    loadBalancer: elbv2.ApplicationLoadBalancer;
    securityGroup: ec2.SecurityGroup;
    identifier: string;
}
export interface IServiceDefinitionProps {
    resource: IResourceDefinitinProps;
    image: string;
    env: {
        [key: string]: string;
    };
    readonly entryPoint?: string[];
    readonly command?: string[];
}
export interface IScalingPolicyDefinitionProps {
    stack: cdk.Construct;
    serviceName: string;
    clusterName: string;
    identifier: string;
}
export declare class SeleniumGridConstruct extends cdk.Construct {
    readonly vpc: ec2.IVpc;
    readonly seleniumVersion: string;
    readonly memory: number;
    readonly cpu: number;
    readonly seleniumNodeMaxInstances: number;
    readonly seleniumNodeMaxSessions: number;
    constructor(scope: cdk.Construct, id: string, props?: ISeleniumGridProps);
    createHubResources(options: IResourceDefinitinProps): void;
    createBrowserResource(options: IResourceDefinitinProps, image: string): void;
    createService(options: IServiceDefinitionProps): ecs.FargateService;
    createScalingPolicy(options: IScalingPolicyDefinitionProps): void;
}
