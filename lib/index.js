"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeleniumGridConstruct = void 0;
const applicationautoscaling = require("@aws-cdk/aws-applicationautoscaling");
const cloudwatch = require("@aws-cdk/aws-cloudwatch");
const ec2 = require("@aws-cdk/aws-ec2");
const ecs = require("@aws-cdk/aws-ecs");
const elbv2 = require("@aws-cdk/aws-elasticloadbalancingv2");
const cdk = require("@aws-cdk/core");
class SeleniumGridConstruct extends cdk.Construct {
    constructor(scope, id, props = {}) {
        var _a, _b, _c, _d, _e, _f;
        super(scope, id);
        // Create new VPC if it doesnt exist
        this.vpc = (_a = props.vpc) !== null && _a !== void 0 ? _a : new ec2.Vpc(this, 'Vpc', { natGateways: 1 });
        this.seleniumVersion = (_b = props.seleniumVersion) !== null && _b !== void 0 ? _b : '3.141.59';
        this.memory = (_c = props.memory) !== null && _c !== void 0 ? _c : 512;
        this.cpu = (_d = props.cpu) !== null && _d !== void 0 ? _d : 256;
        this.seleniumNodeMaxInstances = (_e = props.seleniumNodeMaxInstances) !== null && _e !== void 0 ? _e : 5;
        this.seleniumNodeMaxSessions = (_f = props.seleniumNodeMaxSessions) !== null && _f !== void 0 ? _f : 5;
        // Cluster
        const cluster = new ecs.Cluster(this, 'cluster', {
            vpc: this.vpc,
        });
        // Setup capacity providers and default strategy for cluster
        const cfnEcsCluster = cluster.node.defaultChild;
        cfnEcsCluster.capacityProviders = ['FARGATE', 'FARGATE_SPOT'];
        cfnEcsCluster.defaultCapacityProviderStrategy = [{
                capacityProvider: 'FARGATE',
                weight: 1,
                base: 4,
            }, {
                capacityProvider: 'FARGATE_SPOT',
                weight: 4,
            }];
        // Create security group and add inbound and outbound traffic ports
        var securityGroup = new ec2.SecurityGroup(this, 'security-group-selenium', {
            vpc: cluster.vpc,
            allowAllOutbound: true,
        });
        // Open up port 4444 and 5555 for execution
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(4444), 'Port 4444 for inbound traffic');
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5555), 'Port 5555 for inbound traffic');
        // Setup Load balancer & register targets
        var loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'app-lb', {
            vpc: this.vpc,
            internetFacing: true,
        });
        loadBalancer.addSecurityGroup(securityGroup);
        // Register SeleniumHub resources
        this.createHubResources({
            cluster: cluster,
            identifier: 'hub',
            loadBalancer: loadBalancer,
            securityGroup: securityGroup,
            stack: this,
        });
        // Register Chrome node resources
        this.createBrowserResource({
            cluster: cluster,
            identifier: 'chrome',
            loadBalancer: loadBalancer,
            securityGroup: securityGroup,
            stack: this,
        }, 'selenium/node-chrome');
        // Register Firefox node resources
        this.createBrowserResource({
            cluster: cluster,
            identifier: 'firefox',
            loadBalancer: loadBalancer,
            securityGroup: securityGroup,
            stack: this,
        }, 'selenium/node-firefox');
        new cdk.CfnOutput(this, 'LoadBalancerDNS', {
            exportName: 'Selenium-Hub-DNS',
            value: loadBalancer.loadBalancerDnsName,
        });
    }
    createHubResources(options) {
        var service = this.createService({
            resource: options,
            env: {
                GRID_BROWSER_TIMEOUT: '200000',
                GRID_TIMEOUT: '180',
                SE_OPTS: '-debug',
            },
            image: 'selenium/hub:' + this.seleniumVersion,
        });
        // Create autoscaling policy
        this.createScalingPolicy({
            clusterName: options.cluster.clusterName,
            serviceName: service.serviceName,
            identifier: options.identifier,
            stack: options.stack,
        });
        // Default target routing for 4444 so webdriver client can connect to
        const listener = options.loadBalancer.addListener('Listener', { port: 4444, protocol: elbv2.ApplicationProtocol.HTTP });
        service.registerLoadBalancerTargets({
            containerName: 'selenium-hub-container',
            containerPort: 4444,
            newTargetGroupId: 'ECS',
            protocol: ecs.Protocol.TCP,
            listener: ecs.ListenerConfig.applicationListener(listener, {
                protocol: elbv2.ApplicationProtocol.HTTP,
                port: 4444,
                targets: [service],
            }),
        });
    }
    createBrowserResource(options, image) {
        // Env parameters configured to connect back to selenium hub when new nodes gets added
        var service = this.createService({
            resource: options,
            env: {
                HUB_PORT_4444_TCP_ADDR: options.loadBalancer.loadBalancerDnsName,
                HUB_PORT_4444_TCP_PORT: '4444',
                NODE_MAX_INSTANCES: this.seleniumNodeMaxInstances.toString(),
                NODE_MAX_SESSION: this.seleniumNodeMaxSessions.toString(),
                SE_OPTS: '-debug',
                shm_size: '512',
            },
            image: image + ':' + this.seleniumVersion,
            entryPoint: ['sh', '-c'],
            command: ["PRIVATE=$(curl -s http://169.254.170.2/v2/metadata | jq -r '.Containers[1].Networks[0].IPv4Addresses[0]') ; export REMOTE_HOST=\"http://$PRIVATE:5555\" ; /opt/bin/entry_point.sh"],
        });
        // Create autoscaling policy
        this.createScalingPolicy({
            clusterName: options.cluster.clusterName,
            serviceName: service.serviceName,
            identifier: options.identifier,
            stack: options.stack,
        });
    }
    createService(options) {
        const stack = options.resource.stack;
        const identiifer = options.resource.identifier;
        const cluster = options.resource.cluster;
        const securityGroup = options.resource.securityGroup;
        // Task and container definition
        const taskDefinition = new ecs.FargateTaskDefinition(stack, 'selenium-' + identiifer + '-task-def');
        const containerDefinition = taskDefinition.addContainer('selenium-' + identiifer + '-container', {
            image: ecs.ContainerImage.fromRegistry(options.image),
            memoryLimitMiB: this.memory,
            cpu: this.cpu,
            environment: options.env,
            essential: true,
            logging: new ecs.AwsLogDriver({
                streamPrefix: 'selenium-' + identiifer + '-logs',
            }),
            entryPoint: options.entryPoint,
            command: options.command,
        });
        // Port mapping
        containerDefinition.addPortMappings({
            containerPort: 4444,
            hostPort: 4444,
            protocol: ecs.Protocol.TCP,
        });
        // Setup Fargate service
        return new ecs.FargateService(stack, 'selenium-' + identiifer + '-service', {
            cluster: cluster,
            taskDefinition: taskDefinition,
            minHealthyPercent: 75,
            maxHealthyPercent: 100,
            securityGroups: [securityGroup],
        });
    }
    createScalingPolicy(options) {
        const serviceName = options.serviceName;
        const clusterName = options.clusterName;
        const identifier = options.identifier;
        const stack = options.stack;
        // Scaling set on ECS service level
        const target = new applicationautoscaling.ScalableTarget(stack, 'selenium-hub-step-scalableTarget-' + identifier, {
            serviceNamespace: applicationautoscaling.ServiceNamespace.ECS,
            maxCapacity: 10,
            minCapacity: 1,
            resourceId: 'service/' + clusterName + '/' + serviceName,
            scalableDimension: 'ecs:service:DesiredCount',
        });
        // Metrics to listen
        const workerUtilizationMetric = new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'CPUUtilization',
            statistic: 'max',
            period: cdk.Duration.minutes(1),
            dimensions: {
                ClusterName: clusterName,
                ServiceName: serviceName,
            },
        });
        // Define Scaling policies (scale-in and scale-out)
        // Remove one instance if CPUUtilization is less than 30%,
        // Add one instance if the CPUUtilization is greater than 70%
        target.scaleOnMetric('step-metric-scaling-' + identifier, {
            metric: workerUtilizationMetric,
            adjustmentType: applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
            scalingSteps: [
                { upper: 30, change: -1 },
                { lower: 70, change: +1 },
            ],
            cooldown: cdk.Duration.seconds(180),
        });
    }
}
exports.SeleniumGridConstruct = SeleniumGridConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsOEVBQThFO0FBQzlFLHNEQUFzRDtBQUN0RCx3Q0FBd0M7QUFDeEMsd0NBQXdDO0FBQ3hDLDZEQUE2RDtBQUM3RCxxQ0FBcUM7QUE4Q3JDLE1BQWEscUJBQXNCLFNBQVEsR0FBRyxDQUFDLFNBQVM7SUFTdEQsWUFBWSxLQUFvQixFQUFFLEVBQVUsRUFBRSxRQUE0QixFQUFFOztRQUMxRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLG9DQUFvQztRQUNwQyxJQUFJLENBQUMsR0FBRyxTQUFHLEtBQUssQ0FBQyxHQUFHLG1DQUFJLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDckUsSUFBSSxDQUFDLGVBQWUsU0FBRyxLQUFLLENBQUMsZUFBZSxtQ0FBSSxVQUFVLENBQUM7UUFDM0QsSUFBSSxDQUFDLE1BQU0sU0FBRyxLQUFLLENBQUMsTUFBTSxtQ0FBSSxHQUFHLENBQUM7UUFDbEMsSUFBSSxDQUFDLEdBQUcsU0FBRyxLQUFLLENBQUMsR0FBRyxtQ0FBSSxHQUFHLENBQUM7UUFDNUIsSUFBSSxDQUFDLHdCQUF3QixTQUFHLEtBQUssQ0FBQyx3QkFBd0IsbUNBQUksQ0FBQyxDQUFDO1FBQ3BFLElBQUksQ0FBQyx1QkFBdUIsU0FBRyxLQUFLLENBQUMsdUJBQXVCLG1DQUFJLENBQUMsQ0FBQztRQUVsRSxVQUFVO1FBQ1YsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDL0MsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHO1NBQ2QsQ0FBQyxDQUFDO1FBRUgsNERBQTREO1FBQzVELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FB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QUMsZ0JBQWdCLENBQUMsR0FBRztZQUM3RCxXQUFXLEVBQUUsRUFBRTtZQUNmLFdBQVcsRUFBRSxDQUFDO1lBQ2QsVUFBVSxFQUFFLFVBQVUsR0FBQyxXQUFXLEdBQUMsR0FBRyxHQUFDLFdBQVc7WUFDbEQsaUJBQWlCLEVBQUUsMEJBQTBCO1NBQzlDLENBQUMsQ0FBQztRQUVILG9CQUFvQjtRQUNwQixNQUFNLHVCQUF1QixHQUFHLElBQUksVUFBVSxDQUFDLE1BQU0sQ0FBQztZQUNwRCxTQUFTLEVBQUUsU0FBUztZQUNwQixVQUFVLEVBQUUsZ0JBQWdCO1lBQzVCLFNBQVMsRUFBRSxLQUFLO1lBQ2hCLE1BQU0sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDL0IsVUFBVSxFQUFFO2dCQUNWLFdBQVcsRUFBRSxXQUFXO2dCQUN4QixXQUFXLEVBQUUsV0FBVzthQUN6QjtTQUNGLENBQUMsQ0FBQztRQUVILG1EQUFtRDtRQUNuRCwwREFBMEQ7UUFDMUQsNkRBQTZEO1FBQzdELE1BQU0sQ0FBQyxhQUFhLENBQUMsc0JBQXNCLEdBQUMsVUFBVSxFQUFFO1lBQ3RELE1BQU0sRUFBRSx1QkFBdUI7WUFDL0IsY0FBYyxFQUFFLHNCQUFzQixDQUFDLGNBQWMsQ0FBQyxrQkFBa0I7WUFDeEUsWUFBWSxFQUFFO2dCQUNaLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLEVBQUU7Z0JBQ3pCLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLEVBQUU7YUFDMUI7WUFDRCxRQUFRLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1NBQ3BDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWxPRCxzREFrT0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBhcHBsaWNhdGlvbmF1dG9zY2FsaW5nIGZyb20gJ0Bhd3MtY2RrL2F3cy1hcHBsaWNhdGlvbmF1dG9zY2FsaW5nJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSAnQGF3cy1jZGsvYXdzLWNsb3Vkd2F0Y2gnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ0Bhd3MtY2RrL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ0Bhd3MtY2RrL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnQGF3cy1jZGsvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuXG4vLyBDdXN0b21pemFibGUgY29uc3RydWN0IGlucHV0c1xuZXhwb3J0IGludGVyZmFjZSBJU2VsZW5pdW1HcmlkUHJvcHMge1xuICAvLyBWUENcbiAgcmVhZG9ubHkgdnBjPzogZWMyLklWcGM7XG5cbiAgLy8gU2VsZW5pdW0gdmVyc2lvbiB0byBwdWxsIGluLCBleDozLjE0MS41OVxuICByZWFkb25seSBzZWxlbml1bVZlcnNpb24/OiBzdHJpbmc7XG5cbiAgLy8gTWVtb3J5IHNldHRpbmdzIGZvciBodWIgYW5kIGNocm9tZSBmYXJnYXRlIG5vZGVzLCBleDogNTEyXG4gIHJlYWRvbmx5IG1lbW9yeT86IG51bWJlcjtcblxuICAvLyBDUFUgc2V0dGluZ3MgZm9yIGh1YiBhbmQgY2hyb21lIGZhcmdhdGUgbm9kZXMsIGV4OiAyNTZcbiAgcmVhZG9ubHkgY3B1PzogbnVtYmVyO1xuXG4gIC8vIFNlbGVuaXVtIE5PREVfTUFYX0lOU1RBTkNFUyBwb2ludGluZyB0byBudW1iZXIgb2YgaW5zdGFuY2VzIG9mIHNhbWUgdmVyc2lvbiBvZiBicm93c2VyIHRoYXQgY2FuIHJ1biBpbiBub2RlLCBleDogNVxuICByZWFkb25seSBzZWxlbml1bU5vZGVNYXhJbnN0YW5jZXM/OiBudW1iZXI7XG5cbiAgLy8gU2VsZW5pdW0gTk9ERV9NQVhfU0VTU0lPTiBwb2ludGluZyB0byBudW1iZXIgb2YgYnJvd3NlcnMgKEFueSBicm93c2VyIGFuZCB2ZXJzaW9uKSB0aGF0IGNhbiBydW4gaW4gcGFyYWxsZWwgYXQgYSB0aW1lIGluIG5vZGUsIGV4OiA1XG4gIHJlYWRvbmx5IHNlbGVuaXVtTm9kZU1heFNlc3Npb25zPzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIElSZXNvdXJjZURlZmluaXRpblByb3Bze1xuICBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcbiAgc3RhY2s6IGNkay5Db25zdHJ1Y3Q7XG4gIGxvYWRCYWxhbmNlcjogZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXI7XG4gIHNlY3VyaXR5R3JvdXA6IGVjMi5TZWN1cml0eUdyb3VwO1xuICBpZGVudGlmaWVyOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSVNlcnZpY2VEZWZpbml0aW9uUHJvcHN7XG4gIHJlc291cmNlOiBJUmVzb3VyY2VEZWZpbml0aW5Qcm9wcztcbiAgaW1hZ2U6IHN0cmluZztcbiAgZW52OiB7W2tleTogc3RyaW5nXTogc3RyaW5nfTtcbiAgcmVhZG9ubHkgZW50cnlQb2ludD86IHN0cmluZ1tdO1xuICByZWFkb25seSBjb21tYW5kPzogc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSVNjYWxpbmdQb2xpY3lEZWZpbml0aW9uUHJvcHN7XG4gIHN0YWNrOiBjZGsuQ29uc3RydWN0O1xuICBzZXJ2aWNlTmFtZTogc3RyaW5nO1xuICBjbHVzdGVyTmFtZTogc3RyaW5nO1xuICBpZGVudGlmaWVyOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBTZWxlbml1bUdyaWRDb25zdHJ1Y3QgZXh0ZW5kcyBjZGsuQ29uc3RydWN0IHtcblxuICByZWFkb25seSB2cGM6IGVjMi5JVnBjO1xuICByZWFkb25seSBzZWxlbml1bVZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgbWVtb3J5OiBudW1iZXI7XG4gIHJlYWRvbmx5IGNwdTogbnVtYmVyO1xuICByZWFkb25seSBzZWxlbml1bU5vZGVNYXhJbnN0YW5jZXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgc2VsZW5pdW1Ob2RlTWF4U2Vzc2lvbnM6IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IElTZWxlbml1bUdyaWRQcm9wcyA9IHt9KSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vIENyZWF0ZSBuZXcgVlBDIGlmIGl0IGRvZXNudCBleGlzdFxuICAgIHRoaXMudnBjID0gcHJvcHMudnBjID8/IG5ldyBlYzIuVnBjKHRoaXMsICdWcGMnLCB7IG5hdEdhdGV3YXlzOiAxIH0pO1xuICAgIHRoaXMuc2VsZW5pdW1WZXJzaW9uID0gcHJvcHMuc2VsZW5pdW1WZXJzaW9uID8/ICczLjE0MS41OSc7XG4gICAgdGhpcy5tZW1vcnkgPSBwcm9wcy5tZW1vcnkgPz8gNTEyO1xuICAgIHRoaXMuY3B1ID0gcHJvcHMuY3B1ID8/IDI1NjtcbiAgICB0aGlzLnNlbGVuaXVtTm9kZU1heEluc3RhbmNlcyA9IHByb3BzLnNlbGVuaXVtTm9kZU1heEluc3RhbmNlcyA/PyA1O1xuICAgIHRoaXMuc2VsZW5pdW1Ob2RlTWF4U2Vzc2lvbnMgPSBwcm9wcy5zZWxlbml1bU5vZGVNYXhTZXNzaW9ucyA/PyA1O1xuXG4gICAgLy8gQ2x1c3RlclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ2NsdXN0ZXInLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgIH0pO1xuXG4gICAgLy8gU2V0dXAgY2FwYWNpdHkgcHJvdmlkZXJzIGFuZCBkZWZhdWx0IHN0cmF0ZWd5IGZvciBjbHVzdGVyXG4gICAgY29uc3QgY2ZuRWNzQ2x1c3RlciA9IGNsdXN0ZXIubm9kZS5kZWZhdWx0Q2hpbGQgYXMgZWNzLkNmbkNsdXN0ZXI7XG4gICAgY2ZuRWNzQ2x1c3Rlci5jYXBhY2l0eVByb3ZpZGVycyA9IFsnRkFSR0FURScsICdGQVJHQVRFX1NQT1QnXTtcbiAgICBjZm5FY3NDbHVzdGVyLmRlZmF1bHRDYXBhY2l0eVByb3ZpZGVyU3RyYXRlZ3kgPSBbe1xuICAgICAgY2FwYWNpdHlQcm92aWRlcjogJ0ZBUkdBVEUnLFxuICAgICAgd2VpZ2h0OiAxLFxuICAgICAgYmFzZTogNCxcbiAgICB9LCB7XG4gICAgICBjYXBhY2l0eVByb3ZpZGVyOiAnRkFSR0FURV9TUE9UJyxcbiAgICAgIHdlaWdodDogNCxcbiAgICB9XTtcblxuICAgIC8vIENyZWF0ZSBzZWN1cml0eSBncm91cCBhbmQgYWRkIGluYm91bmQgYW5kIG91dGJvdW5kIHRyYWZmaWMgcG9ydHNcbiAgICB2YXIgc2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnc2VjdXJpdHktZ3JvdXAtc2VsZW5pdW0nLCB7XG4gICAgICB2cGM6IGNsdXN0ZXIudnBjLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIE9wZW4gdXAgcG9ydCA0NDQ0IGFuZCA1NTU1IGZvciBleGVjdXRpb25cbiAgICBzZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDQ0NDQpLCAnUG9ydCA0NDQ0IGZvciBpbmJvdW5kIHRyYWZmaWMnKTtcbiAgICBzZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDU1NTUpLCAnUG9ydCA1NTU1IGZvciBpbmJvdW5kIHRyYWZmaWMnKTtcblxuICAgIC8vIFNldHVwIExvYWQgYmFsYW5jZXIgJiByZWdpc3RlciB0YXJnZXRzXG4gICAgdmFyIGxvYWRCYWxhbmNlciA9IG5ldyBlbGJ2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnYXBwLWxiJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIGludGVybmV0RmFjaW5nOiB0cnVlLFxuICAgIH0pO1xuICAgIGxvYWRCYWxhbmNlci5hZGRTZWN1cml0eUdyb3VwKHNlY3VyaXR5R3JvdXApO1xuXG4gICAgLy8gUmVnaXN0ZXIgU2VsZW5pdW1IdWIgcmVzb3VyY2VzXG4gICAgdGhpcy5jcmVhdGVIdWJSZXNvdXJjZXMoe1xuICAgICAgY2x1c3RlcjogY2x1c3RlcixcbiAgICAgIGlkZW50aWZpZXI6ICdodWInLFxuICAgICAgbG9hZEJhbGFuY2VyOiBsb2FkQmFsYW5jZXIsXG4gICAgICBzZWN1cml0eUdyb3VwOiBzZWN1cml0eUdyb3VwLFxuICAgICAgc3RhY2s6IHRoaXMsXG4gICAgfSk7XG5cbiAgICAvLyBSZWdpc3RlciBDaHJvbWUgbm9kZSByZXNvdXJjZXNcbiAgICB0aGlzLmNyZWF0ZUJyb3dzZXJSZXNvdXJjZSh7XG4gICAgICBjbHVzdGVyOiBjbHVzdGVyLFxuICAgICAgaWRlbnRpZmllcjogJ2Nocm9tZScsXG4gICAgICBsb2FkQmFsYW5jZXI6IGxvYWRCYWxhbmNlcixcbiAgICAgIHNlY3VyaXR5R3JvdXA6IHNlY3VyaXR5R3JvdXAsXG4gICAgICBzdGFjazogdGhpcyxcbiAgICB9LCAnc2VsZW5pdW0vbm9kZS1jaHJvbWUnKTtcblxuICAgIC8vIFJlZ2lzdGVyIEZpcmVmb3ggbm9kZSByZXNvdXJjZXNcbiAgICB0aGlzLmNyZWF0ZUJyb3dzZXJSZXNvdXJjZSh7XG4gICAgICBjbHVzdGVyOiBjbHVzdGVyLFxuICAgICAgaWRlbnRpZmllcjogJ2ZpcmVmb3gnLFxuICAgICAgbG9hZEJhbGFuY2VyOiBsb2FkQmFsYW5jZXIsXG4gICAgICBzZWN1cml0eUdyb3VwOiBzZWN1cml0eUdyb3VwLFxuICAgICAgc3RhY2s6IHRoaXMsXG4gICAgfSwgJ3NlbGVuaXVtL25vZGUtZmlyZWZveCcpO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIGV4cG9ydE5hbWU6ICdTZWxlbml1bS1IdWItRE5TJyxcbiAgICAgIHZhbHVlOiBsb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUh1YlJlc291cmNlcyhvcHRpb25zOiBJUmVzb3VyY2VEZWZpbml0aW5Qcm9wcykge1xuICAgIHZhciBzZXJ2aWNlID0gdGhpcy5jcmVhdGVTZXJ2aWNlKHtcbiAgICAgIHJlc291cmNlOiBvcHRpb25zLFxuICAgICAgZW52OiB7XG4gICAgICAgIEdSSURfQlJPV1NFUl9USU1FT1VUOiAnMjAwMDAwJyxcbiAgICAgICAgR1JJRF9USU1FT1VUOiAnMTgwJyxcbiAgICAgICAgU0VfT1BUUzogJy1kZWJ1ZycsXG4gICAgICB9LFxuICAgICAgaW1hZ2U6ICdzZWxlbml1bS9odWI6Jyt0aGlzLnNlbGVuaXVtVmVyc2lvbixcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBhdXRvc2NhbGluZyBwb2xpY3lcbiAgICB0aGlzLmNyZWF0ZVNjYWxpbmdQb2xpY3koe1xuICAgICAgY2x1c3Rlck5hbWU6IG9wdGlvbnMuY2x1c3Rlci5jbHVzdGVyTmFtZSxcbiAgICAgIHNlcnZpY2VOYW1lOiBzZXJ2aWNlLnNlcnZpY2VOYW1lLFxuICAgICAgaWRlbnRpZmllcjogb3B0aW9ucy5pZGVudGlmaWVyLFxuICAgICAgc3RhY2s6IG9wdGlvbnMuc3RhY2ssXG4gICAgfSk7XG5cbiAgICAvLyBEZWZhdWx0IHRhcmdldCByb3V0aW5nIGZvciA0NDQ0IHNvIHdlYmRyaXZlciBjbGllbnQgY2FuIGNvbm5lY3QgdG9cbiAgICBjb25zdCBsaXN0ZW5lciA9IG9wdGlvbnMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdMaXN0ZW5lcicsIHsgcG9ydDogNDQ0NCwgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCB9KTtcbiAgICBzZXJ2aWNlLnJlZ2lzdGVyTG9hZEJhbGFuY2VyVGFyZ2V0cyh7XG4gICAgICBjb250YWluZXJOYW1lOiAnc2VsZW5pdW0taHViLWNvbnRhaW5lcicsXG4gICAgICBjb250YWluZXJQb3J0OiA0NDQ0LFxuICAgICAgbmV3VGFyZ2V0R3JvdXBJZDogJ0VDUycsXG4gICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICAgIGxpc3RlbmVyOiBlY3MuTGlzdGVuZXJDb25maWcuYXBwbGljYXRpb25MaXN0ZW5lcihsaXN0ZW5lciwge1xuICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgICBwb3J0OiA0NDQ0LFxuICAgICAgICB0YXJnZXRzOiBbc2VydmljZV0sXG4gICAgICB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUJyb3dzZXJSZXNvdXJjZShvcHRpb25zOiBJUmVzb3VyY2VEZWZpbml0aW5Qcm9wcywgaW1hZ2U6IHN0cmluZykge1xuXG4gICAgLy8gRW52IHBhcmFtZXRlcnMgY29uZmlndXJlZCB0byBjb25uZWN0IGJhY2sgdG8gc2VsZW5pdW0gaHViIHdoZW4gbmV3IG5vZGVzIGdldHMgYWRkZWRcbiAgICB2YXIgc2VydmljZSA9IHRoaXMuY3JlYXRlU2VydmljZSh7XG4gICAgICByZXNvdXJjZTogb3B0aW9ucyxcbiAgICAgIGVudjoge1xuICAgICAgICBIVUJfUE9SVF80NDQ0X1RDUF9BRERSOiBvcHRpb25zLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgICBIVUJfUE9SVF80NDQ0X1RDUF9QT1JUOiAnNDQ0NCcsXG4gICAgICAgIE5PREVfTUFYX0lOU1RBTkNFUzogdGhpcy5zZWxlbml1bU5vZGVNYXhJbnN0YW5jZXMudG9TdHJpbmcoKSxcbiAgICAgICAgTk9ERV9NQVhfU0VTU0lPTjogdGhpcy5zZWxlbml1bU5vZGVNYXhTZXNzaW9ucy50b1N0cmluZygpLFxuICAgICAgICBTRV9PUFRTOiAnLWRlYnVnJyxcbiAgICAgICAgc2htX3NpemU6ICc1MTInLFxuICAgICAgfSxcbiAgICAgIGltYWdlOiBpbWFnZSsnOicrdGhpcy5zZWxlbml1bVZlcnNpb24sXG4gICAgICBlbnRyeVBvaW50OiBbJ3NoJywgJy1jJ10sXG4gICAgICBjb21tYW5kOiBbXCJQUklWQVRFPSQoY3VybCAtcyBodHRwOi8vMTY5LjI1NC4xNzAuMi92Mi9tZXRhZGF0YSB8IGpxIC1yICcuQ29udGFpbmVyc1sxXS5OZXR3b3Jrc1swXS5JUHY0QWRkcmVzc2VzWzBdJykgOyBleHBvcnQgUkVNT1RFX0hPU1Q9XFxcImh0dHA6Ly8kUFJJVkFURTo1NTU1XFxcIiA7IC9vcHQvYmluL2VudHJ5X3BvaW50LnNoXCJdLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIGF1dG9zY2FsaW5nIHBvbGljeVxuICAgIHRoaXMuY3JlYXRlU2NhbGluZ1BvbGljeSh7XG4gICAgICBjbHVzdGVyTmFtZTogb3B0aW9ucy5jbHVzdGVyLmNsdXN0ZXJOYW1lLFxuICAgICAgc2VydmljZU5hbWU6IHNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBpZGVudGlmaWVyOiBvcHRpb25zLmlkZW50aWZpZXIsXG4gICAgICBzdGFjazogb3B0aW9ucy5zdGFjayxcbiAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZVNlcnZpY2Uob3B0aW9uczogSVNlcnZpY2VEZWZpbml0aW9uUHJvcHMpOiBlY3MuRmFyZ2F0ZVNlcnZpY2Uge1xuICAgIGNvbnN0IHN0YWNrID0gb3B0aW9ucy5yZXNvdXJjZS5zdGFjaztcbiAgICBjb25zdCBpZGVudGlpZmVyID0gb3B0aW9ucy5yZXNvdXJjZS5pZGVudGlmaWVyO1xuICAgIGNvbnN0IGNsdXN0ZXIgPSBvcHRpb25zLnJlc291cmNlLmNsdXN0ZXI7XG4gICAgY29uc3Qgc2VjdXJpdHlHcm91cCA9IG9wdGlvbnMucmVzb3VyY2Uuc2VjdXJpdHlHcm91cDtcblxuICAgIC8vIFRhc2sgYW5kIGNvbnRhaW5lciBkZWZpbml0aW9uXG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbihzdGFjaywgJ3NlbGVuaXVtLScraWRlbnRpaWZlcisnLXRhc2stZGVmJyk7XG4gICAgY29uc3QgY29udGFpbmVyRGVmaW5pdGlvbiA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignc2VsZW5pdW0tJytpZGVudGlpZmVyKyctY29udGFpbmVyJywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkob3B0aW9ucy5pbWFnZSksXG4gICAgICBtZW1vcnlMaW1pdE1pQjogdGhpcy5tZW1vcnksXG4gICAgICBjcHU6IHRoaXMuY3B1LFxuICAgICAgZW52aXJvbm1lbnQ6IG9wdGlvbnMuZW52LFxuICAgICAgZXNzZW50aWFsOiB0cnVlLFxuICAgICAgbG9nZ2luZzogbmV3IGVjcy5Bd3NMb2dEcml2ZXIoe1xuICAgICAgICBzdHJlYW1QcmVmaXg6ICdzZWxlbml1bS0nK2lkZW50aWlmZXIrJy1sb2dzJyxcbiAgICAgIH0pLFxuICAgICAgZW50cnlQb2ludDogb3B0aW9ucy5lbnRyeVBvaW50LFxuICAgICAgY29tbWFuZDogb3B0aW9ucy5jb21tYW5kLFxuICAgIH0pO1xuXG4gICAgLy8gUG9ydCBtYXBwaW5nXG4gICAgY29udGFpbmVyRGVmaW5pdGlvbi5hZGRQb3J0TWFwcGluZ3Moe1xuICAgICAgY29udGFpbmVyUG9ydDogNDQ0NCxcbiAgICAgIGhvc3RQb3J0OiA0NDQ0LFxuICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgfSk7XG5cbiAgICAvLyBTZXR1cCBGYXJnYXRlIHNlcnZpY2VcbiAgICByZXR1cm4gbmV3IGVjcy5GYXJnYXRlU2VydmljZShzdGFjaywgJ3NlbGVuaXVtLScraWRlbnRpaWZlcisnLXNlcnZpY2UnLCB7XG4gICAgICBjbHVzdGVyOiBjbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb246IHRhc2tEZWZpbml0aW9uLFxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDc1LFxuICAgICAgbWF4SGVhbHRoeVBlcmNlbnQ6IDEwMCxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbc2VjdXJpdHlHcm91cF0sXG4gICAgfSk7XG4gIH1cblxuICBjcmVhdGVTY2FsaW5nUG9saWN5KG9wdGlvbnM6IElTY2FsaW5nUG9saWN5RGVmaW5pdGlvblByb3BzKSB7XG4gICAgY29uc3Qgc2VydmljZU5hbWUgPSBvcHRpb25zLnNlcnZpY2VOYW1lO1xuICAgIGNvbnN0IGNsdXN0ZXJOYW1lID0gb3B0aW9ucy5jbHVzdGVyTmFtZTtcbiAgICBjb25zdCBpZGVudGlmaWVyID0gb3B0aW9ucy5pZGVudGlmaWVyO1xuICAgIGNvbnN0IHN0YWNrID0gb3B0aW9ucy5zdGFjaztcblxuICAgIC8vIFNjYWxpbmcgc2V0IG9uIEVDUyBzZXJ2aWNlIGxldmVsXG4gICAgY29uc3QgdGFyZ2V0ID0gbmV3IGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcuU2NhbGFibGVUYXJnZXQoc3RhY2ssICdzZWxlbml1bS1odWItc3RlcC1zY2FsYWJsZVRhcmdldC0nK2lkZW50aWZpZXIsIHtcbiAgICAgIHNlcnZpY2VOYW1lc3BhY2U6IGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcuU2VydmljZU5hbWVzcGFjZS5FQ1MsXG4gICAgICBtYXhDYXBhY2l0eTogMTAsXG4gICAgICBtaW5DYXBhY2l0eTogMSxcbiAgICAgIHJlc291cmNlSWQ6ICdzZXJ2aWNlLycrY2x1c3Rlck5hbWUrJy8nK3NlcnZpY2VOYW1lLFxuICAgICAgc2NhbGFibGVEaW1lbnNpb246ICdlY3M6c2VydmljZTpEZXNpcmVkQ291bnQnLFxuICAgIH0pO1xuXG4gICAgLy8gTWV0cmljcyB0byBsaXN0ZW5cbiAgICBjb25zdCB3b3JrZXJVdGlsaXphdGlvbk1ldHJpYyA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvRUNTJyxcbiAgICAgIG1ldHJpY05hbWU6ICdDUFVVdGlsaXphdGlvbicsXG4gICAgICBzdGF0aXN0aWM6ICdtYXgnLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgIGRpbWVuc2lvbnM6IHtcbiAgICAgICAgQ2x1c3Rlck5hbWU6IGNsdXN0ZXJOYW1lLFxuICAgICAgICBTZXJ2aWNlTmFtZTogc2VydmljZU5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRGVmaW5lIFNjYWxpbmcgcG9saWNpZXMgKHNjYWxlLWluIGFuZCBzY2FsZS1vdXQpXG4gICAgLy8gUmVtb3ZlIG9uZSBpbnN0YW5jZSBpZiBDUFVVdGlsaXphdGlvbiBpcyBsZXNzIHRoYW4gMzAlLFxuICAgIC8vIEFkZCBvbmUgaW5zdGFuY2UgaWYgdGhlIENQVVV0aWxpemF0aW9uIGlzIGdyZWF0ZXIgdGhhbiA3MCVcbiAgICB0YXJnZXQuc2NhbGVPbk1ldHJpYygnc3RlcC1tZXRyaWMtc2NhbGluZy0nK2lkZW50aWZpZXIsIHtcbiAgICAgIG1ldHJpYzogd29ya2VyVXRpbGl6YXRpb25NZXRyaWMsXG4gICAgICBhZGp1c3RtZW50VHlwZTogYXBwbGljYXRpb25hdXRvc2NhbGluZy5BZGp1c3RtZW50VHlwZS5DSEFOR0VfSU5fQ0FQQUNJVFksXG4gICAgICBzY2FsaW5nU3RlcHM6IFtcbiAgICAgICAgeyB1cHBlcjogMzAsIGNoYW5nZTogLTEgfSxcbiAgICAgICAgeyBsb3dlcjogNzAsIGNoYW5nZTogKzEgfSxcbiAgICAgIF0sXG4gICAgICBjb29sZG93bjogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTgwKSxcbiAgICB9KTtcbiAgfVxufSJdfQ==