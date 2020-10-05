const cdk = require('@aws-cdk/core');
const ec2 = require("@aws-cdk/aws-ec2");
const ecs = require("@aws-cdk/aws-ecs");
const ecs_patterns = require("@aws-cdk/aws-ecs-patterns");
const efs = require('@aws-cdk/aws-efs');
const iam = require('@aws-cdk/aws-iam');
const logs = require('@aws-cdk/aws-logs');
const secretsmanager = require('@aws-cdk/aws-secretsmanager');
const { CfnOutput } = require('@aws-cdk/core');

class CdkGrafanaStack extends cdk.Stack {
  /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Get Context Values
    const domainName = this.node.tryGetContext('domainName');
    const hostedZoneId = this.node.tryGetContext('hostedZoneId');
    const zoneName = this.node.tryGetContext('zoneName');
    const enablePrivateLink = this.node.tryGetContext('enablePrivateLink');

    // vpc
    const vpc = new ec2.Vpc(this, "MyVpc", {
      maxAzs: 2 // Default is all AZs in region
    });

    if (enablePrivateLink == 'true') {
      vpc.addInterfaceEndpoint('CWEndpoint',  {service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH});
      vpc.addInterfaceEndpoint('EFSEndpoint', {service: ec2.InterfaceVpcEndpointAwsService.ELASTIC_FILESYSTEM});
      vpc.addInterfaceEndpoint('SMEndpoint',  {service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER});
    }

    // ecs cluster
    const cluster = new ecs.Cluster(this, "MyCluster", {
      vpc: vpc
    });

    // EFS
    const fileSystem = new efs.FileSystem(this, 'EfsFileSystem', {
      vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING
    });

    const accessPoint = new efs.AccessPoint(this, 'EfsAccessPoint', {
      fileSystem: fileSystem,
      path: '/var/lib/grafana',
      posixUser: {
        gid: '1000',
        uid: '1000'
      },
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755'
      }
    });

    // task log group
    const logGroup = new logs.LogGroup(this, 'taskLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH
    });

    // container log driver
    const containerLogDriver = ecs.LogDrivers.awsLogs({
      streamPrefix: 'fargate-grafana', //cdk.Stack.stackName,
      logGroup: logGroup
    });

    // task Role
    const taskRole = new iam.Role(this, 'taskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:DescribeAlarmsForMetric',
        'cloudwatch:DescribeAlarmHistory',
        'cloudwatch:DescribeAlarms',
        'cloudwatch:ListMetrics',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:GetMetricData',
        'ec2:DescribeTags',
        'ec2:DescribeInstances',
        'ec2:DescribeRegions',
        'tag:GetResources'
      ],
      resources: ['*']
    }));

    // execution Role
    const executionRole = new iam.Role(this, 'executionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    executionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        logGroup.logGroupArn
      ]
    }));

    // Create Task Definition - # EFS integration currently uses escape hatches until native CDK support is added #
    const volumeName = 'efsGrafanaVolume'
    // https://aws.amazon.com/blogs/aws/amazon-ecs-supports-efs/
    const task_definition = new ecs.FargateTaskDefinition(this, "TaskDef",{
      taskRole: taskRole,
      executionRole: executionRole,
      volumes:[
        {
          name: volumeName
        }
      ]
    });

    // Extract low level CfnResource - you can find the 'path' to the Cfn Resource in the metadata of the resource in the generated Cfn
    const task_definition_volumes = task_definition.node.defaultChild
    // Override Settings in task_definition_volumes - Add the EFS configuration
    task_definition_volumes.addPropertyOverride(
      'Volumes',[{
        Name: volumeName,
        EFSVolumeConfiguration: {
          FilesystemId: fileSystem.fileSystemId,
          TransitEncryption: 'ENABLED',
          AuthorizationConfig: {
            AccessPointId: accessPoint.accessPointId
          }
        }
      }]
    )

    // Grafana Admin Password
    const grafanaAdminPassword = new secretsmanager.Secret(this, 'grafanaAdminPassword');
    // Allow Task to access Grafana Admin Password
    grafanaAdminPassword.grantRead(taskRole);

    // Web Container
    const container_web = task_definition.addContainer("web", {
        image: ecs.ContainerImage.fromRegistry('grafana/grafana'),
        logging: containerLogDriver,
        secrets: {
          GF_SECURITY_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(grafanaAdminPassword)
        }
      }
    );
    // set port mapping
    container_web.addPortMappings({
      containerPort: 3000
    });
    container_web.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/var/lib/grafana',
      readOnly: false
    })

    // Create a load-balanced Fargate service and make it public
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "MyFargateService", {
      domainName: domainName,
      domainZone: {
        hostedZoneId: hostedZoneId, 
        zoneName: zoneName
      },
      cluster: cluster, // Required
      cpu: 1024, // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html
      desiredCount: 1, // Should be set to 1 to prevent multiple tasks attempting to write to EFS volume concurrently
      taskDefinition: task_definition,
      memoryLimitMiB: 2048, // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html
      protocol: "HTTPS",
      publicLoadBalancer: true, // Default is false
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4 // LATEST should work too
    });

    // Extract low level CfnResource - you can find the 'path' to the Cfn Resource in the metadata of the resource in the generated Cfn
    const applicationTargetGroup = fargateService.loadBalancer.node.findChild('PublicListener').node.findChild('ECSGroup').node.defaultChild
    // Override Settings in CfnResource - Set the allowed response code
    applicationTargetGroup.addPropertyOverride('Matcher',{"HttpCode" : "200,302"})

    // Allow Task to access EFS
    fileSystem.connections.allowDefaultPortFrom(fargateService.service.connections);

    // Outputs
    // new CfnOutput(this, "url" , {
    //   value: ('http://' + fargateService.loadBalancer.loadBalancerDnsName)
    // });
  }
}

module.exports = { CdkGrafanaStack }

// https://grafana.com/docs/grafana/latest/installation/configure-docker/
// https://github.com/monitoringartist/grafana-aws-cloudwatch-dashboards