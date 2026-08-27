# 1. Isolated Subnets (No Internet Gateway routing)
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "db_isolated" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "{{PROJECT_NAME}}-db-isolated-${count.index}"
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "{{PROJECT_NAME}}-db-subnet-group"
  subnet_ids = aws_subnet.db_isolated[*].id
}

# 2. Database Security Group
resource "aws_security_group" "rds" {
  name        = "{{PROJECT_NAME}}-rds-sg"
  vpc_id      = aws_vpc.main.id

  # ONLY allow inbound traffic from the ECS Fargate tasks
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# 3. The PostgreSQL Instance
resource "aws_db_instance" "postgres" {
  identifier                  = "{{PROJECT_NAME}}-db"
  engine                      = "postgres"
  engine_version              = "16.1"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  
  # Clean up dashes for the database name (e.g. my-project -> my_project)
  db_name                     = replace("{{PROJECT_NAME}}", "-", "_") 
  username                    = "dbadmin"
  
  # AWS automatically creates and manages the secret in Secrets Manager!
  manage_master_user_password = true 

  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.rds.id]
  
  skip_final_snapshot         = true
  publicly_accessible         = false
}

# 4. IAM Permission for RDS Master Password Secret
resource "aws_iam_role_policy" "rds_secret_access" {
  name   = "{{PROJECT_NAME}}-rds-secret-policy"
  role   = aws_iam_role.execution_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_db_instance.postgres.master_user_secret[0].secret_arn
        ]
      }
    ]
  })
}