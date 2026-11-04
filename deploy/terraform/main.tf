# Instagram Grid Maker on Oracle Cloud's Always Free tier: one VM, its network and firewall. Nothing here costs money
# within the Always Free limits (Ampere A1: up to 4 OCPUs and 24 GB in total; 200 GB of block volume).
#
# Run by ../../deploy.sh, which passes the tenancy, region and SSH key. Credentials come from ~/.oci/config.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 6.0.0, < 10.0.0"
    }
  }
}

provider "oci" {
  config_file_profile = var.oci_profile
  region              = var.region
}

locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  flex           = length(regexall("Flex$", var.instance_shape)) > 0
  # sslip.io answers <a-b-c-d>.sslip.io with a.b.c.d, so the VM gets an HTTPS name without buying a domain.
  hostname = var.domain != "" ? var.domain : "${replace(oci_core_instance.app.public_ip, ".", "-")}.sslip.io"
}

data "oci_identity_availability_domains" "all" {
  compartment_id = var.tenancy_ocid
}

# The newest Canonical Ubuntu 24.04 image for the shape (aarch64 for Ampere A1), without the Minimal variants.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"

  filter {
    name   = "display_name"
    values = ["^Canonical-Ubuntu-24\\.04-(aarch64-)?[0-9.]+-[0-9]+$"]
    regex  = true
  }
}

resource "oci_core_vcn" "main" {
  compartment_id = local.compartment_id
  cidr_blocks    = ["10.42.0.0/16"]
  display_name   = "${var.name}-vcn"
  dns_label      = "gridmaker"
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name}-public"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source   = var.ssh_cidr
    protocol = "6"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP for Let's Encrypt's challenge and the redirect, HTTPS for the service.
  dynamic "ingress_security_rules" {
    for_each = [80, 443]
    content {
      source   = "0.0.0.0/0"
      protocol = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }

  # Path MTU discovery.
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = "10.42.1.0/24"
  display_name               = "${var.name}-public"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_instance" "app" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.all.availability_domains[var.availability_domain_index].name
  display_name        = var.name
  shape               = var.instance_shape

  dynamic "shape_config" {
    for_each = local.flex ? [1] : []
    content {
      ocpus         = var.ocpus
      memory_in_gbs = var.memory_gb
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = "app"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/cloud-init.yaml"))
  }

  # A newer image, edited cloud-init or another availability domain (deploy.sh tries them in turn when one is full)
  # must not replace the VM: its public IP, and with it the registered HTTPS address, would change.
  lifecycle {
    ignore_changes = [source_details, metadata, availability_domain]
  }
}
