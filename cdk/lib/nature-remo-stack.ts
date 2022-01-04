import {
  aws_apigateway,
  aws_events,
  aws_stepfunctions,
  aws_stepfunctions_tasks,
  Stack,
  StackProps,
  Duration,
  aws_events_targets,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class NatureRemoStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // define api gateway
    const xAuthorization = "method.request.header.x-Authorization";
    const remoEndpoint = new aws_apigateway.RestApi(
      this,
      "NatureRemoEndpoint",
      {
        defaultIntegration: new aws_apigateway.HttpIntegration(
          "https://api.nature.global/1/devices",
          {
            options: {
              requestParameters: {
                "integration.request.header.Authorization": xAuthorization,
              },
            },
          }
        ),
      }
    );

    remoEndpoint.root.addMethod("GET", undefined, {
      requestParameters: { [xAuthorization]: true },
    });

    // define cfn task,
    // get token task
    const taskToGetSecret = new aws_stepfunctions_tasks.CallAwsService(
      this,
      "GetSecretTask",
      {
        service: "ssm",
        action: "getParameter",
        parameters: { Name: "/plantor/nature-remo-token" },
        iamResources: ["*"],
        iamAction: "ssm:GetParameter",
        resultSelector: {
          "Token.$": "$.Parameter.Value",
        },
        resultPath: "$.SecretOutput",
      }
    );
    // call api task
    const taskToCallApi =
      new aws_stepfunctions_tasks.CallApiGatewayRestApiEndpoint(
        this,
        "CallNatureRemoTask",
        {
          api: remoEndpoint,
          stageName: remoEndpoint.deploymentStage.stageName,
          method: aws_stepfunctions_tasks.HttpMethod.GET,
          headers: aws_stepfunctions.TaskInput.fromObject({
            "x-Authorization": aws_stepfunctions.JsonPath.stringAt(
              "States.Array(States.Format('Bearer {}', $.SecretOutput.Token))"
            ),
          }),
          resultSelector: {
            "Events.$": "$.ResponseBody[1].newest_events",
          },
          resultPath: "$.NatureRemoOutput",
        }
      );
    // put metric task
    const taskToPutMetric = new aws_stepfunctions_tasks.CallAwsService(
      this,
      "PutMetricTask",
      {
        service: "cloudwatch",
        action: "putMetricData",
        parameters: {
          Namespace: "CUSTOM-IoT/Room",
          MetricData: [
            {
              MetricName: "Temperature",
              Value: aws_stepfunctions.JsonPath.numberAt(
                "$.NatureRemoOutput.Events.te.val"
              ),
            },
          ],
        },
        iamResources: ["*"],
        iamAction: "cloudwatch:PutMetricData",
        resultPath: "$.PutMetricOutput",
      }
    );

    const stateMachine = new aws_stepfunctions.StateMachine(
      this,
      "MyStateMachine",
      {
        definition: taskToGetSecret.next(taskToCallApi).next(taskToPutMetric),
      }
    );

    new aws_events.Rule(this, "ScheduleRule", {
      schedule: aws_events.Schedule.rate(Duration.minutes(60)),
      targets: [new aws_events_targets.SfnStateMachine(stateMachine)],
    });
  }
}
