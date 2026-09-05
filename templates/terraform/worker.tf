# --- Worker ECS Task Definition ---
resource "aws_ecs_task_definition" "worker" {
  family                   = "{{PROJECT_NAME}}-worker-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "{{CPU}}"
  memory                   = "{{MEMORY}}"
  execution_role_arn       = aws_iam_role.execution_role.arn
  task_role_arn            = aws_iam_role.task_role.arn

  container_definitions = jsonencode([
    {
      name      = "{{PROJECT_NAME}}-worker-container"
      image     = "${aws_ecr_repository.app.repository_url}:latest"
      essential = true

      environment = [
        { "name": "NODE_ENV", "value": "production" },
        {{DB_ENV_VARS}}
      ]

      secrets = concat(
        [
          for key in local.secret_keys : {
            name      = key
            valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:${key}::"
          }
        ],
        [
          {{TASK_SECRETS}}
        ]
      )

      {{WORKER_COMMAND}}

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app_logs.name
          "awslogs-region"        = "{{REGION}}"
          "awslogs-stream-prefix" = "worker" # Isolates worker logs from web logs
        }
      }
    }
  ])
}

# --- Worker ECS Service ---
# Notice there is NO load_balancer block. This service is strictly private.
resource "aws_ecs_service" "worker" {
  name            = "{{PROJECT_NAME}}-worker-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  launch_type     = "FARGATE"
  desired_count   = 1

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true 
  }
}